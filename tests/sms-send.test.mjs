// Integration tests for the SMS pipeline (send-sms + retry-queued-sms Edge
// Functions and the sms_queue table), against the disposable test project.
//
// SAFETY: these tests refuse to run unless the test project's `sms_provider`
// setting is 'mock' — the no-op adapter that logs instead of sending. That
// guard is what makes this file safe to run repeatedly: no real text is ever
// delivered and nothing is ever billed. If someone configures a live provider
// on the test project, these tests fail loudly in before() rather than quietly
// texting strangers.
//
// Note this inverts an assumption from email-retry.test.mjs: that file relies
// on Zoho being unconfigured so every send FAILS. Here the mock provider always
// SUCCEEDS, so a send/retry is asserted to reach 'Sent'.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, adminEmail, adminPassword, service } from './helpers.mjs';

const anon = createClient(url, anonKey);

// Ofcom-reserved drama numbers (07700 900xxx) — permanently unallocated, so
// even a misconfiguration can't reach a real subscriber.
const SEND_TO_NATIONAL = '07700 900123';
const SEND_TO_E164 = '+447700900123';
const SEED_RECIPIENT = '+447700900199';

let adminToken;

before(async () => {
  const { data, error } = await anon.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${error.message}`);
  adminToken = data.session.access_token;

  // The safety interlock described at the top of this file.
  const { data: providerRow } = await service
    .from('settings').select('value').eq('key', 'sms_provider').maybeSingle();
  const provider = providerRow?.value ?? '(unset)';
  if (provider !== 'mock') {
    throw new Error(
      `Refusing to run SMS tests: sms_provider on the test project is "${provider}", not "mock". ` +
      `These tests would send real, billable texts.`
    );
  }

  await service.from('sms_queue').delete().in('recipient', [SEND_TO_E164, SEED_RECIPIENT]);
});

after(async () => {
  await service.from('sms_queue').delete().in('recipient', [SEND_TO_E164, SEED_RECIPIENT]);
});

async function callSend(body, token = adminToken) {
  const res = await fetch(`${url}/functions/v1/send-sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: anonKey },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function callRetry(body, token = adminToken) {
  const res = await fetch(`${url}/functions/v1/retry-queued-sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: anonKey },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function seedRow(status, extra = {}) {
  const { data, error } = await service
    .from('sms_queue')
    .insert({
      recipient: SEED_RECIPIENT,
      body: 'Retry test body',
      status,
      error_message: status === 'Error' ? 'original failure' : null,
      ...extra,
    })
    .select()
    .single();
  assert.equal(error, null, error?.message);
  return data;
}

describe('send-sms', () => {
  test('rejects an unauthenticated caller', async () => {
    const { status } = await callSend({ recipient: SEND_TO_NATIONAL, body: 'nope' }, anonKey);
    assert.equal(status, 401);
  });

  test('rejects a missing recipient', async () => {
    const { status, json } = await callSend({ body: 'no recipient' });
    assert.equal(status, 400, JSON.stringify(json));
  });

  test('rejects a phone number it cannot normalise to E.164', async () => {
    const { status, json } = await callSend({ recipient: 'not-a-number', body: 'x' });
    assert.equal(status, 400, JSON.stringify(json));
  });

  test('rejects bare "44" and "0" - the GB trunk-prefix branches previously skipped length validation entirely', async () => {
    const bare44 = await callSend({ recipient: '44', body: 'x' });
    assert.equal(bare44.status, 400, JSON.stringify(bare44.json));

    const bareZero = await callSend({ recipient: '0', body: 'x' });
    assert.equal(bareZero.status, 400, JSON.stringify(bareZero.json));
  });

  test('sends, normalising a UK national number to E.164 and logging to sms_queue', async () => {
    const { status, json } = await callSend({ recipient: SEND_TO_NATIONAL, body: 'ESF single part test' });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.success, true);
    assert.equal(json.status, 'Sent');
    assert.equal(json.segments, 1);
    assert.match(json.provider_message_id || '', /^mock-/,
      'the mock adapter should return a mock- prefixed id, proving the dispatch reached an adapter');
    assert.equal(json.recipient, SEND_TO_E164,
      'the response must report the NORMALISED number actually sent to, which is what the client audits');

    // The audit row is written with the NORMALISED number, not what was passed in.
    const { data: rows } = await service
      .from('sms_queue').select('recipient, status, segments, provider_message_id')
      .eq('recipient', SEND_TO_E164).order('id', { ascending: false }).limit(1);

    assert.equal(rows.length, 1, 'the send must be logged to sms_queue');
    assert.equal(rows[0].recipient, SEND_TO_E164, '07700 900123 must be stored as +447700900123');
    assert.equal(rows[0].status, 'Sent');
    assert.equal(rows[0].segments, 1);
  });

  test('counts multi-part messages so billing is visible', async () => {
    // 200 GSM-7 chars spills past the 160-char single-part limit.
    const longBody = 'A'.repeat(200);
    const { status, json } = await callSend({ recipient: SEND_TO_NATIONAL, body: longBody });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.segments, 2, '200 GSM-7 chars should bill as 2 parts (153 each once concatenated)');
  });
});

describe('retry-queued-sms', () => {
  test('rejects an unauthenticated caller and leaves the row untouched', async () => {
    const row = await seedRow('Error');
    const { status } = await callRetry({ id: row.id }, anonKey);
    assert.equal(status, 401);

    const { data: after } = await service.from('sms_queue').select('status, retry_count').eq('id', row.id).single();
    assert.equal(after.status, 'Error');
    assert.equal(after.retry_count, 0);
  });

  test('rejects a non-numeric id', async () => {
    const { status, json } = await callRetry({ id: 'not-a-number' });
    assert.equal(status, 400, JSON.stringify(json));
  });

  test('returns 404 for an id that does not exist', async () => {
    const { status, json } = await callRetry({ id: 2147483600 });
    assert.equal(status, 404, JSON.stringify(json));
  });

  test('retries a failed send and stamps retry_count / last_retry_at', async () => {
    const row = await seedRow('Error');

    const { status, json } = await callRetry({ id: row.id });
    assert.equal(status, 200, JSON.stringify(json));
    // Unlike the email equivalent, the mock provider succeeds — so a retry
    // resolves the row rather than re-failing it.
    assert.equal(json.success, true);
    assert.equal(json.status, 'Sent');
    assert.equal(json.retry_count, 1);

    const { data: updated } = await service
      .from('sms_queue').select('status, error_message, retry_count, last_retry_at, provider_message_id')
      .eq('id', row.id).single();

    assert.equal(updated.status, 'Sent', 'row must not be left stuck in Processing');
    assert.equal(updated.retry_count, 1);
    assert.ok(updated.last_retry_at, 'last_retry_at must be stamped');
    assert.equal(updated.error_message, null, 'a successful retry must clear the previous error');
    assert.match(updated.provider_message_id || '', /^mock-/);
  });

  test('refuses to retry an already-Sent row (never re-send, or re-bill, a delivered text)', async () => {
    const row = await seedRow('Sent');
    const { status, json } = await callRetry({ id: row.id });
    assert.equal(status, 409, JSON.stringify(json));
    assert.match(json.error || '', /Sent/);

    const { data: after } = await service.from('sms_queue').select('status, retry_count').eq('id', row.id).single();
    assert.equal(after.status, 'Sent');
    assert.equal(after.retry_count, 0);
  });

  test('refuses to retry a Pending row (that belongs to the bulk-drain path)', async () => {
    const row = await seedRow('Pending');
    const { status, json } = await callRetry({ id: row.id });
    assert.equal(status, 409, JSON.stringify(json));
  });

  // Same reasoning as email-retry.test.mjs: two concurrent HTTP calls don't
  // reliably overlap, so this exercises the claim primitive the function is
  // built on — a conditional Error -> Processing update where "no rows matched"
  // is the rejection. Deterministic, because nothing resets the status back.
  test('the row claim is atomic: only one of two concurrent claims matches', async () => {
    const row = await seedRow('Error');

    const [c1, c2] = await Promise.all([
      service.from('sms_queue').update({ status: 'Processing' }).eq('id', row.id).eq('status', 'Error').select(),
      service.from('sms_queue').update({ status: 'Processing' }).eq('id', row.id).eq('status', 'Error').select(),
    ]);

    const winners = [c1, c2].filter((r) => (r.data || []).length > 0);
    assert.equal(winners.length, 1,
      `exactly one concurrent claim should match, got ${winners.length} — ` +
      `two winners would mean two callers could both send (and bill) the same text`);
  });
});

// Bulk sends derive their recipients server-side from Confirmed bookings, so
// these need real booking fixtures rather than just queue rows.
const BULK_PREFIX = 'ESF26-SMSBULK-';

async function insertBooking(id, overrides = {}) {
  const { error } = await service.from('bookings').insert({
    id,
    status: 'Confirmed',
    business_name: `Bulk SMS Test ${id}`,
    owner_name: 'Test Owner',
    email: 'bulk-sms-test@example.test',
    instance_prefix: 'ESF26-DEV-',
    stall_type: 'Food',
    ...overrides,
  });
  if (error) throw new Error(`Fixture setup failed for ${id}: ${error.message}`);
}

async function callBulk(body, token = adminToken) {
  const res = await fetch(`${url}/functions/v1/queue-bulk-sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: anonKey },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

describe('queue-bulk-sms', () => {
  const withPhone = `${BULK_PREFIX}A`;
  const withPhone2 = `${BULK_PREFIX}B`;
  const noPhone = `${BULK_PREFIX}NOPHONE`;
  const notConfirmed = `${BULK_PREFIX}PENDING`;
  const allIds = [withPhone, withPhone2, noPhone, notConfirmed];

  before(async () => {
    await service.from('sms_queue').delete().like('recipient', '+447700900%');
    await service.from('bookings').delete().in('id', allIds);
    await insertBooking(withPhone, { phone: '07700 900321' });
    await insertBooking(withPhone2, { phone: '+447700900322' });
    await insertBooking(noPhone, { phone: null });
    await insertBooking(notConfirmed, { phone: '07700 900323', status: 'Pending' });
  });

  after(async () => {
    await service.from('bookings').delete().in('id', allIds);
    await service.from('sms_queue').delete().in('recipient', ['+447700900321', '+447700900322', '+447700900323']);
  });

  test('rejects an unauthenticated caller', async () => {
    const { status } = await callBulk({ bookingIds: [withPhone], body: 'nope' }, anonKey);
    assert.equal(status, 401);
  });

  test('rejects an empty or missing bookingIds array', async () => {
    const { status } = await callBulk({ bookingIds: [], body: 'x' });
    assert.equal(status, 400);
  });

  test('queues only Confirmed bookings that have a usable phone number', async () => {
    const { status, json } = await callBulk({ bookingIds: allIds, body: 'Festival is on Saturday 10am.' });
    assert.equal(status, 200, JSON.stringify(json));

    // 2 queued (the two with phones), 1 skipped (Confirmed but no phone).
    // The Pending booking is filtered out server-side before the phone check,
    // so it is neither queued nor counted as skipped.
    assert.equal(json.queued, 2, JSON.stringify(json));
    assert.equal(json.skipped, 1, JSON.stringify(json));

    const { data: rows } = await service
      .from('sms_queue').select('recipient')
      .in('recipient', ['+447700900321', '+447700900322', '+447700900323']);
    const got = (rows || []).map((r) => r.recipient).sort();

    // Both stored forms normalise to E.164, and the Pending booking's number
    // must be absent — recipients are re-derived server-side, so passing its
    // id cannot cause a send.
    assert.deepEqual(got, ['+447700900321', '+447700900322']);
  });

  test('refuses a bulk send where no supplied booking is reachable', async () => {
    const { status, json } = await callBulk({ bookingIds: [noPhone, notConfirmed], body: 'x' });
    assert.equal(status, 400, JSON.stringify(json));
  });
});

describe('sms_templates', () => {
  // Every template a code path references without an opt-in check first.
  // getSmsFromTemplate() throws on a missing row, so an absent template turns
  // the Confirm/Reject/Cancel tickbox into a guaranteed error toast at the
  // worst moment — after the status change has already committed — and turns
  // a submitter's phone number into a guaranteed console.warn on every single
  // public submission (submit-booking's sendReceivedSms is unconditional,
  // with no tickbox to skip).
  const REQUIRED = ['booking_confirmed', 'booking_rejected', 'booking_cancelled', 'booking_received', 'location_update', 'payment_requested'];

  for (const id of REQUIRED) {
    test(`the ${id} template exists and is substitutable`, async () => {
      const { data, error } = await service
        .from('sms_templates').select('body').eq('id', id).single();

      assert.equal(error, null, error?.message);
      assert.match(data.body, /\{\{owner_name\}\}/,
        'the template must carry the placeholder getSmsFromTemplate substitutes');
    });
  }

  // booking_confirmed, booking_received, and location_update all carry
  // {{cancel_link}} (and booking_confirmed also {{bank_details}}/{{cost}})
  // as of 20260730090000 — a deliberate, approved trade-off to always
  // include a working cancel link and (for the confirmation) the bank
  // transfer details, even though that means 2 billed parts instead of 1.
  // payment_requested (20260731090000) is 2 parts too, once a realistic
  // owner name and cost are filled in — deliberately does NOT carry the
  // Stripe checkout link itself (~400+ chars, would be 6-8 parts), so it
  // stays far cheaper than that link would have made it.
  // booking_rejected and booking_cancelled were NOT touched (nothing left to
  // cancel once a booking is rejected/cancelled) and must stay single-part.
  const ALLOWED_MULTIPART = new Set(['booking_confirmed', 'booking_received', 'location_update', 'payment_requested']);

  test('only the templates approved for it bill as more than one part', () => {
    // Mirrors countSegments() in _shared/sms.ts.
    const GSM7 = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
    const parts = (t) => {
      const u = !GSM7.test(t);
      return u ? (t.length <= 70 ? 1 : Math.ceil(t.length / 67))
               : (t.length <= 160 ? 1 : Math.ceil(t.length / 153));
    };
    // Longest realistic substitutions, so this is an upper bound. {{reason}}
    // is filled at exactly MAX_SMS_REASON_LEN (js/shared.js) — an admin's
    // rejection reason has no length limit of its own, so the true worst
    // case is whatever the app's own truncation guard allows through, not
    // an arbitrarily long string. {{cancel_link}} uses a real-shaped
    // uuid-token URL; {{bank_details}} uses the same worst-case shape as
    // the settings card (see tests/stripe-credentials-save.test.mjs-style
    // fixtures elsewhere in this repo).
    const filled = (b) => b
      .replace(/\{\{owner_name\}\}/g, 'Christopher Fotheringay')
      .replace(/\{\{business_name\}\}/g, 'The Artisan Bakery Company')
      .replace(/\{\{booking_id\}\}/g, 'ESF26-GENERAL-0042')
      .replace(/\{\{cost\}\}/g, '£120.00')
      .replace(/\{\{reason\}\}/g, 'This is a fairly long admin-typed rea...') // 40 ASCII chars, matching the truncation guard's own output
      .replace(/\{\{cancel_link\}\}/g, 'https://app.ellastreet.co.uk/cancel_booking.html?token=' + 'a'.repeat(36))
      .replace(/\{\{bank_details\}\}/g, 'Account Name: Ella Street Festival, Sort Code: 12-34-56, Account Number: 12345678')
      // {{payment_link}} is our own short pay.html redirect keyed on
      // bookings.payment_link_code — a fixed 8-char url-safe random code
      // (20260731110000_payment_link_short_code.sql), not a uuid or the
      // Stripe session id, so this fake is exact-length, not worst-case.
      .replace(/\{\{payment_link\}\}/g, 'https://app.ellastreet.co.uk/pay.html?token=' + 'a'.repeat(8));

    return service.from('sms_templates').select('id, body').then(({ data, error }) => {
      assert.equal(error, null, error?.message);
      const oversized = (data || [])
        .map((r) => ({ id: r.id, parts: parts(filled(r.body)), len: filled(r.body).length }))
        .filter((r) => r.parts > 1);
      const unapproved = oversized.filter((r) => !ALLOWED_MULTIPART.has(r.id));
      assert.deepEqual(unapproved, [],
        `these templates bill as more than one part without being on the approved list: ${JSON.stringify(unapproved)}`);
    });
  });
});
