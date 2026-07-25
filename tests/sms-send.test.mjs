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

process.loadEnvFile('.env.test');

const url = process.env.TEST_SUPABASE_URL;
const anonKey = process.env.TEST_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const adminEmail = process.env.TEST_ADMIN_EMAIL;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;

if (!url || !url.includes('qeplpcnrkgpaawfyliap')) {
  throw new Error(`Refusing to run integration tests against a non-test project: ${url}`);
}

const anon = createClient(url, anonKey);
const service = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

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

  test('sends, normalising a UK national number to E.164 and logging to sms_queue', async () => {
    const { status, json } = await callSend({ recipient: SEND_TO_NATIONAL, body: 'ESF single part test' });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.success, true);
    assert.equal(json.status, 'Sent');
    assert.equal(json.segments, 1);
    assert.match(json.provider_message_id || '', /^mock-/,
      'the mock adapter should return a mock- prefixed id, proving the dispatch reached an adapter');

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

describe('sms_templates', () => {
  test('the seeded booking_confirmed template exists and is substitutable', async () => {
    const { data, error } = await service
      .from('sms_templates').select('body').eq('id', 'booking_confirmed').single();

    assert.equal(error, null, error?.message);
    assert.match(data.body, /\{\{owner_name\}\}/,
      'the confirmation template must carry the placeholder getSmsFromTemplate substitutes');
  });
});
