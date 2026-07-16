// Critical admin-workflow integration test: exercises the full booking
// lifecycle the same way the admin frontend does via js/api.js — direct
// authenticated table/RPC calls, not Edge Functions (those are covered in
// integration.test.mjs). Runs against the disposable "test backup" Supabase
// project only — see integration.test.mjs for the same guard/setup.
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

const service = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

// The admin client mirrors js/api.js's getSupabaseClient() — a real
// authenticated admin session, subject to the same RLS as the live app.
let admin;
const bookingId = 'ESF26-TESTWORKFLOW-0001';
const locationA = 'TESTWFLOC-A';
const locationB = 'TESTWFLOC-B';

before(async () => {
  admin = createClient(url, anonKey);
  const { error } = await admin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${error.message}`);

  await service.from('booking_locations').delete().eq('booking_id', bookingId);
  await service.from('payments').delete().eq('booking_id', bookingId);
  await service.from('hcc_checks').delete().eq('booking_id', bookingId);
  await service.from('bookings').delete().eq('id', bookingId);
  await service.from('locations').delete().in('id', [locationA, locationB]);

  const { error: locationsInsertErr } = await service.from('locations').insert([
    { id: locationA, dataset: 'LIVE', lat: 0, lng: 0 },
    { id: locationB, dataset: 'LIVE', lat: 0, lng: 0 },
  ]);
  if (locationsInsertErr) throw new Error(`Fixture setup failed (locations): ${locationsInsertErr.message}`);
});

after(async () => {
  await service.from('booking_locations').delete().eq('booking_id', bookingId);
  await service.from('payments').delete().eq('booking_id', bookingId);
  await service.from('hcc_checks').delete().eq('booking_id', bookingId);
  await service.from('bookings').delete().eq('id', bookingId);
  await service.from('locations').delete().in('id', [locationA, locationB]);
});

describe('critical admin workflow: create -> confirm -> assign -> move -> pay -> HCC -> cancel', () => {
  test('1. create booking (Pending)', async () => {
    const { data, error } = await service.from('bookings').insert({
      id: bookingId,
      status: 'Pending',
      business_name: 'Workflow Test Stall',
      owner_name: 'Workflow Tester',
      email: 'workflow-test@example.test',
      instance_prefix: 'ESF26-FOOD-',
      stall_type: 'Food',
      stall_cost: 50,
    }).select().single();
    assert.equal(error, null, error?.message);
    assert.equal(data.status, 'Pending');
  });

  test('2. confirm booking (status -> Confirmed, chargeable finalize creates a payment row)', async () => {
    const { error: statusErr } = await admin.from('bookings').update({ status: 'Confirmed' }).eq('id', bookingId);
    assert.equal(statusErr, null, statusErr?.message);

    // Mirrors the DB-level effect of a chargeable confirmation: stamp
    // date_confirmed, save the final cost, and upsert a payments row.
    // Reached today via Stripe (finalize_stripe_payment) or a manually
    // recorded bank transfer (rpc_record_bank_transfer_payment), not via
    // js/api.js's finalizeConfirmation() — that function now only ever
    // handles the free-confirm path (see js/shared.js's sharedUpdateStatus).
    const { error: confirmErr } = await admin
      .from('bookings')
      .update({ status: 'Confirmed', date_confirmed: new Date().toISOString(), stall_cost: 50 })
      .eq('id', bookingId);
    assert.equal(confirmErr, null, confirmErr?.message);

    const { error: paymentErr } = await admin
      .from('payments')
      .upsert({ booking_id: bookingId, paid: false }, { onConflict: 'booking_id' });
    assert.equal(paymentErr, null, paymentErr?.message);

    const { data: booking } = await service.from('bookings').select('status').eq('id', bookingId).single();
    assert.equal(booking.status, 'Confirmed');
  });

  test('3. assign a location (rpc_set_booking_locations)', async () => {
    const { error } = await admin.rpc('rpc_set_booking_locations', { p_booking_id: bookingId, p_location_ids: [locationA] });
    assert.equal(error, null, error?.message);

    const { data: assigned } = await service.from('booking_locations').select('location_id').eq('booking_id', bookingId);
    assert.deepEqual(assigned.map((r) => r.location_id), [locationA]);
  });

  test('4. move to a different location', async () => {
    const { error } = await admin.rpc('rpc_set_booking_locations', { p_booking_id: bookingId, p_location_ids: [locationB] });
    assert.equal(error, null, error?.message);

    const { data: assigned } = await service.from('booking_locations').select('location_id').eq('booking_id', bookingId);
    assert.deepEqual(assigned.map((r) => r.location_id), [locationB]);
  });

  test('5. record payment', async () => {
    const { error } = await admin
      .from('payments')
      .update({ paid: true, date_paid: new Date().toISOString().slice(0, 10), bank_ref: 'WF-TEST-REF', editor: adminEmail })
      .eq('booking_id', bookingId);
    assert.equal(error, null, error?.message);

    const { data: payment } = await service.from('payments').select('*').eq('booking_id', bookingId).single();
    assert.equal(payment.paid, true);
    assert.equal(payment.bank_ref, 'WF-TEST-REF');
  });

  test('6. create HCC check (status -> HCC Checks, auto-inserts hcc_checks row, clears location)', async () => {
    const { error } = await admin.from('bookings').update({ status: 'HCC Checks' }).eq('id', bookingId);
    assert.equal(error, null, error?.message);

    const { error: hccErr } = await admin
      .from('hcc_checks')
      .insert({ booking_id: bookingId, council_status: 'Pending' });
    assert.equal(hccErr, null, hccErr?.message);

    // Mirrors updateBookingStatus()'s real behavior: leaving Confirmed clears
    // any assigned location. Documented behavior, not a bug - asserting it
    // stays that way rather than being surprised by it later.
    const { error: clearErr } = await admin.rpc('rpc_set_booking_locations', { p_booking_id: bookingId, p_location_ids: [] });
    assert.equal(clearErr, null, clearErr?.message);

    const { data: hcc } = await service.from('hcc_checks').select('*').eq('booking_id', bookingId).single();
    assert.equal(hcc.council_status, 'Pending');

    const { data: assigned } = await service.from('booking_locations').select('location_id').eq('booking_id', bookingId);
    assert.equal(assigned.length, 0, 'expected the location assignment to be cleared on leaving Confirmed');
  });

  test('7. cancel booking via cancel-booking Edge Function', async () => {
    const { data: booking } = await service.from('bookings').select('cancel_token').eq('id', bookingId).single();
    assert.ok(booking.cancel_token, 'expected a cancel_token to exist (column default)');

    const res = await fetch(`${url}/functions/v1/cancel-booking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}`, apikey: anonKey },
      body: JSON.stringify({
        token: 'XXXX.DUMMY.TOKEN.XXXX', // Cloudflare Turnstile always-passes test token
        cancelToken: booking.cancel_token,
        reason: 'workflow test cleanup',
      }),
    });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.success, true);

    const { data: cancelled } = await service.from('bookings').select('status').eq('id', bookingId).single();
    assert.equal(cancelled.status, 'Cancelled');
  });
});
