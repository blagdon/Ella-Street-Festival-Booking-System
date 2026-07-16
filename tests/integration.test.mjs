// Integration tests against the disposable "test backup" Supabase project.
// NEVER point these at the real project — see the guard below.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.test');

const url = process.env.TEST_SUPABASE_URL;
const anonKey = process.env.TEST_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const adminEmail = process.env.TEST_ADMIN_EMAIL;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;

if (!url || !url.includes('qeplpcnrkgpaawfyliap')) {
  throw new Error(`Refusing to run integration tests against a non-test project: ${url}`);
}

// Cloudflare's official always-passes Turnstile test token/secret pair —
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
// Not a CAPTCHA bypass: this is the sanctioned mechanism for testing
// Turnstile-gated flows without solving a real challenge.
const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

const anon = createClient(url, anonKey);
const service = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

let adminToken;
const createdBookingIds = [];

before(async () => {
  const { data, error } = await anon.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${error.message}`);
  adminToken = data.session.access_token;

  // Clean slate: wipe anything left over from a previous run.
  await service.from('booking_locations').delete().neq('id', -1);
  // Scoped to this file's own fixture prefixes only - test files share one
  // remote database, so a broad wildcard here would delete another test
  // file's fixtures out from under it (confirmed live: this collided with
  // security.test.mjs/workflow.test.mjs before test:integration was pinned
  // to --test-concurrency=1).
  await service.from('bookings').delete().or('id.like.ESF26-TESTCONFLICT-%,id.like.ESF26-TESTDATASET-%,id.like.ESF26-DEV-%');
  await service.from('email_queue').delete().neq('id', -1);
  await service.from('locations').delete().like('id', 'TESTLOC%');
});

after(async () => {
  if (createdBookingIds.length) {
    await service.from('booking_locations').delete().in('booking_id', createdBookingIds);
    await service.from('bookings').delete().in('id', createdBookingIds);
  }
  await service.from('email_queue').delete().neq('id', -1);
  await service.from('locations').delete().like('id', 'TESTLOC%');
});

async function callFunction(name, body, token = anonKey) {
  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function submitBookingPayload(idSuffix, bookingDataOverrides = {}) {
  return {
    token: TURNSTILE_TEST_TOKEN,
    bookingData: {
      instance_prefix: 'ESF26-FOOD-',
      stall_type: 'Food',
      business_name: `Test Business ${idSuffix}`,
      owner_name: `Test Owner ${idSuffix}`,
      email: 'test@example.test',
      phone: '07000000000',
      address: '1 Test Street',
      description: 'Integration test booking',
      category: 'Test',
      ...bookingDataOverrides,
    },
  };
}

describe('get_next_booking_id concurrency', () => {
  test('two concurrent full submissions never collide on booking id', async () => {
    const prefix = 'ESF26-DEV-';
    const [a, b] = await Promise.all([
      callFunction('submit-booking', submitBookingPayload('A', { instance_prefix: prefix })),
      callFunction('submit-booking', submitBookingPayload('B', { instance_prefix: prefix })),
    ]);

    for (const r of [a, b]) {
      if (r.json?.data?.[0]?.id) createdBookingIds.push(r.json.data[0].id);
    }

    const ok = [a, b].filter((r) => r.status === 200 && r.json?.success);
    const failed = [a, b].filter((r) => r.status !== 200 || !r.json?.success);

    assert.equal(ok.length, 2, `expected both concurrent submissions to succeed, got: ${JSON.stringify({ a, b })}`);
    assert.equal(failed.length, 0);

    const ids = ok.map((r) => r.json.data[0].id);
    assert.equal(new Set(ids).size, 2, `expected two distinct booking IDs, got: ${JSON.stringify(ids)}`);
  });
});

describe('booking_locations_check_conflict trigger', () => {
  test('blocks assigning the same location to two Confirmed bookings in the same dataset', async () => {
    const locationId = 'TESTLOC1';
    await service.from('locations').insert({ id: locationId, dataset: 'LIVE', lat: 0, lng: 0 });

    const bookingA = 'ESF26-TESTCONFLICT-A';
    const bookingB = 'ESF26-TESTCONFLICT-B';
    createdBookingIds.push(bookingA, bookingB);

    for (const id of [bookingA, bookingB]) {
      await service.from('bookings').insert({
        id,
        status: 'Confirmed',
        business_name: `Conflict Test ${id}`,
        owner_name: 'Test',
        email: 'test@example.test',
        instance_prefix: 'ESF26-FOOD-',
        stall_type: 'Food',
      });
    }

    const { error: firstErr } = await service.from('booking_locations').insert({ booking_id: bookingA, location_id: locationId });
    assert.equal(firstErr, null, `first assignment should succeed: ${firstErr?.message}`);

    const { error: secondErr } = await service.from('booking_locations').insert({ booking_id: bookingB, location_id: locationId });
    assert.ok(secondErr, 'expected the trigger to reject assigning the same location to a second Confirmed booking');
  });

  test('does not falsely block the same location id across DEV and LIVE datasets', async () => {
    const locationId = 'TESTLOC2';
    await service.from('locations').insert([
      { id: locationId, dataset: 'LIVE', lat: 0, lng: 0 },
    ]);

    const liveBooking = 'ESF26-TESTDATASET-LIVE';
    const devBooking = 'ESF26-DEV-TESTDATASET';
    createdBookingIds.push(liveBooking, devBooking);

    await service.from('bookings').insert([
      { id: liveBooking, status: 'Confirmed', business_name: 'Live', owner_name: 'Test', email: 'test@example.test', instance_prefix: 'ESF26-FOOD-', stall_type: 'Food' },
      { id: devBooking, status: 'Confirmed', business_name: 'Dev', owner_name: 'Test', email: 'test@example.test', instance_prefix: 'ESF26-DEV-', stall_type: 'Food' },
    ]);

    const { error: liveErr } = await service.from('booking_locations').insert({ booking_id: liveBooking, location_id: locationId });
    assert.equal(liveErr, null, `LIVE assignment should succeed: ${liveErr?.message}`);

    const { error: devErr } = await service.from('booking_locations').insert({ booking_id: devBooking, location_id: locationId });
    assert.equal(devErr, null, `DEV booking assigning the same location id should NOT be blocked (different dataset): ${devErr?.message}`);
  });

  // The two tests above only prove the trigger catches an ALREADY-COMMITTED
  // conflict - assign first, then try again, sequentially. A prior version
  // of this test tried the harder question via Promise.all() on two direct
  // service-role inserts, bypassing rpc_set_booking_locations() entirely to
  // hit the trigger's plain SELECT-then-RAISE check directly. It passed,
  // but that turned out to be a false negative: forcing a real overlap with
  // an injected delay (a one-off diagnostic against the trigger, not
  // checked in) proved the race genuinely exists at the trigger level - two
  // concurrent inserts that both pass the check both commit, and the pitch
  // ends up double-booked. Two HTTP round trips through PostgREST just
  // don't reliably land in that microsecond-scale window on their own.
  //
  // The fix (see migration 20260716064846_lock_booking_locations_against_race)
  // was deliberately placed in rpc_set_booking_locations() - the sole write
  // path this table has from application code - via LOCK TABLE ... IN SHARE
  // ROW EXCLUSIVE MODE, mirroring get_next_booking_id()'s existing fix for
  // the identical class of bug. So this test now goes through that RPC
  // (matching how js/api.js and js/page-steward.js actually call it),
  // not a direct table insert, since that's the path the fix protects.
  test('two concurrent rpc_set_booking_locations calls for the same location never both succeed', async () => {
    const locationId = 'TESTLOC-RACE';
    await service.from('locations').insert({ id: locationId, dataset: 'LIVE', lat: 0, lng: 0 });

    const bookingA = 'ESF26-TESTCONFLICT-RACE-A';
    const bookingB = 'ESF26-TESTCONFLICT-RACE-B';
    createdBookingIds.push(bookingA, bookingB);

    for (const id of [bookingA, bookingB]) {
      await service.from('bookings').insert({
        id,
        status: 'Confirmed',
        business_name: `Race Test ${id}`,
        owner_name: 'Test',
        email: 'test@example.test',
        instance_prefix: 'ESF26-FOOD-',
        stall_type: 'Food',
      });
    }

    const [resA, resB] = await Promise.all([
      anon.rpc('rpc_set_booking_locations', { p_booking_id: bookingA, p_location_ids: [locationId] }),
      anon.rpc('rpc_set_booking_locations', { p_booking_id: bookingB, p_location_ids: [locationId] }),
    ]);

    const succeeded = [resA, resB].filter((r) => r.error === null);
    const failed = [resA, resB].filter((r) => r.error !== null);

    // Ground truth: however many calls *reported* success, the table
    // itself must only actually hold one row for this location - two
    // concurrent successes would mean the pitch is genuinely double-booked.
    const { data: finalRows } = await service.from('booking_locations').select('booking_id').eq('location_id', locationId);

    assert.equal(finalRows.length, 1,
      `expected exactly one booking_locations row for ${locationId} after concurrent assignment, got ${finalRows.length} ` +
      `(${succeeded.length} concurrent call(s) reported success, ${failed.length} reported an error) - ` +
      `a count of 2 here means the check-then-act race is real and this pitch is double-booked`);
  });
});

describe('claim_pending_emails self-heal (claimed_at, not created_at)', () => {
  test('reclaims a row stuck in Processing for over 15 minutes', async () => {
    const { data: inserted, error: insErr } = await service
      .from('email_queue')
      .insert({
        recipient: 'stale@example.test',
        subject: 'stale test',
        body: 'stale test',
        status: 'Processing',
        claimed_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      })
      .select()
      .single();
    assert.equal(insErr, null, insErr?.message);

    const { data: claimed, error } = await service.rpc('claim_pending_emails', { p_batch_size: 50 });
    assert.equal(error, null, error?.message);
    assert.ok(claimed.some((r) => r.id === inserted.id), 'expected the 20-minute-old Processing row to be reclaimed');
  });

  test('does not reclaim a row that entered Processing recently', async () => {
    const { data: inserted, error: insErr } = await service
      .from('email_queue')
      .insert({
        recipient: 'fresh@example.test',
        subject: 'fresh test',
        body: 'fresh test',
        status: 'Processing',
        claimed_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      })
      .select()
      .single();
    assert.equal(insErr, null, insErr?.message);

    const { data: claimed, error } = await service.rpc('claim_pending_emails', { p_batch_size: 50 });
    assert.equal(error, null, error?.message);
    assert.ok(!claimed.some((r) => r.id === inserted.id), 'expected the 2-minute-old Processing row NOT to be reclaimed');
  });
});

describe('submit-booking', () => {
  test('mass-assignment: client-supplied admin fields are ignored', async () => {
    const { status, json } = await callFunction('submit-booking', submitBookingPayload('MASSASSIGN', {
      instance_prefix: 'ESF26-DEV-',
      stall_cost: 99999,
      admin_notes: 'should not be settable by the public',
      status: 'Confirmed',
    }));

    assert.equal(status, 200, JSON.stringify(json));
    const booking = json.data[0];
    createdBookingIds.push(booking.id);

    assert.equal(booking.status, 'Pending', 'status must be forced to Pending regardless of client input');
    assert.equal(booking.admin_notes, null, 'admin_notes must not be settable via the public endpoint');
  });

  test('logs the "received" email as Error when Zoho is unconfigured (no real send)', async () => {
    const { status, json } = await callFunction('submit-booking', submitBookingPayload('EMAILERR', {
      instance_prefix: 'ESF26-DEV-',
    }));
    assert.equal(status, 200, JSON.stringify(json));
    createdBookingIds.push(json.data[0].id);

    // sendReceivedEmail is fire-and-forget from the caller's perspective; give it a moment.
    await new Promise((r) => setTimeout(r, 1500));

    const { data: rows } = await service
      .from('email_queue')
      .select('*')
      .eq('recipient', 'test@example.test')
      .order('created_at', { ascending: false })
      .limit(1);

    assert.ok(rows.length, 'expected an email_queue row to be logged');
    assert.equal(rows[0].status, 'Error', 'expected the send to fail (no zoho_* settings configured in the test project)');
  });
});

describe('cancel-booking', () => {
  test('cancels a booking by its token and logs the confirmation email as Error', async () => {
    const bookingId = 'ESF26-TESTCANCEL-0001';
    const cancelToken = '11111111-1111-1111-1111-111111111111';
    createdBookingIds.push(bookingId);

    await service.from('bookings').insert({
      id: bookingId,
      status: 'Pending',
      business_name: 'Cancel Test',
      owner_name: 'Test',
      email: 'test@example.test',
      instance_prefix: 'ESF26-FOOD-',
      stall_type: 'Food',
      cancel_token: cancelToken,
    });

    const { status, json } = await callFunction('cancel-booking', {
      token: TURNSTILE_TEST_TOKEN,
      cancelToken,
      reason: 'integration test',
    });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.success, true);

    const { data: booking } = await service.from('bookings').select('status').eq('id', bookingId).single();
    assert.equal(booking.status, 'Cancelled');

    await new Promise((r) => setTimeout(r, 1500));
    const { data: rows } = await service
      .from('email_queue')
      .select('*')
      .eq('recipient', 'test@example.test')
      .order('created_at', { ascending: false })
      .limit(1);
    assert.ok(rows.length, 'expected a cancellation email_queue row to be logged');
    assert.equal(rows[0].status, 'Error');
  });
});

describe('queue-bulk-email', () => {
  test('rejects an unauthenticated request', async () => {
    const { status } = await callFunction('queue-bulk-email', { bookingIds: ['x'], subject: 's', body: 'b' }, anonKey);
    assert.equal(status, 401);
  });

  test('admin can queue a bulk email for a Confirmed booking, and it drains to Error', async () => {
    const bookingId = 'ESF26-TESTBULK-0001';
    createdBookingIds.push(bookingId);
    await service.from('bookings').insert({
      id: bookingId,
      status: 'Confirmed',
      business_name: 'Bulk Test',
      owner_name: 'Test',
      email: 'test-bulk@example.test',
      instance_prefix: 'ESF26-FOOD-',
      stall_type: 'Food',
    });

    const { status, json } = await callFunction(
      'queue-bulk-email',
      { bookingIds: [bookingId], subject: 'Bulk test', body: 'Bulk test body' },
      adminToken
    );
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.queued, 1);

    // Background drain needs a moment.
    await new Promise((r) => setTimeout(r, 3000));
    const { data: rows } = await service
      .from('email_queue')
      .select('*')
      .eq('recipient', 'test-bulk@example.test')
      .order('created_at', { ascending: false })
      .limit(1);
    assert.ok(rows.length, 'expected the queued row to exist');
    assert.notEqual(rows[0].status, 'Pending', 'expected the drain loop to have picked it up (not still Pending)');
  });
});
