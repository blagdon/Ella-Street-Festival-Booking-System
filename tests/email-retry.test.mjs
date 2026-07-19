// Integration tests for the retry-queued-email Edge Function (the Email Queue
// viewer's "Retry" button), against the disposable test project.
//
// The test project deliberately has no working Zoho credentials, so every
// send attempt fails. That's what makes these tests safe — no real email is
// ever delivered — and it's also the assertion mechanism: a row that gets
// re-sent comes back as 'Error' with a fresh error_message and an incremented
// retry_count, which proves the send was genuinely attempted rather than
// short-circuited.
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

const RECIPIENT = 'retry-test@example.test';
let adminToken;

before(async () => {
  const { data, error } = await anon.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${error.message}`);
  adminToken = data.session.access_token;

  await service.from('email_queue').delete().eq('recipient', RECIPIENT);
});

after(async () => {
  await service.from('email_queue').delete().eq('recipient', RECIPIENT);
});

async function callRetry(body, token = adminToken) {
  const res = await fetch(`${url}/functions/v1/retry-queued-email`, {
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

async function seedRow(status, extra = {}) {
  const { data, error } = await service
    .from('email_queue')
    .insert({
      recipient: RECIPIENT,
      subject: 'Retry test',
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

describe('retry-queued-email', () => {
  test('rejects an unauthenticated caller', async () => {
    const row = await seedRow('Error');
    const { status } = await callRetry({ id: row.id }, anonKey);
    assert.equal(status, 401);

    // The row must be untouched by a rejected call.
    const { data: after } = await service.from('email_queue').select('status, retry_count').eq('id', row.id).single();
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

  test('retries a failed send: attempts delivery, stamps retry_count and last_retry_at', async () => {
    const row = await seedRow('Error');

    const { status, json } = await callRetry({ id: row.id });
    assert.equal(status, 200, JSON.stringify(json));

    // Zoho is unconfigured in the test project, so the resend fails - which
    // is itself the proof it was genuinely attempted.
    assert.equal(json.success, false);
    assert.equal(json.status, 'Error');
    assert.equal(json.retry_count, 1);

    const { data: updated } = await service
      .from('email_queue')
      .select('status, error_message, retry_count, last_retry_at')
      .eq('id', row.id)
      .single();

    assert.equal(updated.status, 'Error', 'row must not be left stuck in Processing');
    assert.equal(updated.retry_count, 1);
    assert.ok(updated.last_retry_at, 'last_retry_at must be stamped');
    assert.notEqual(updated.error_message, 'original failure',
      'error_message should be replaced with the fresh failure, not left as the original');
  });

  test('retry_count accumulates across repeated retries', async () => {
    const row = await seedRow('Error');
    await callRetry({ id: row.id });
    const { json } = await callRetry({ id: row.id });
    assert.equal(json.retry_count, 2, JSON.stringify(json));
  });

  test('refuses to retry an already-Sent row (never re-send a delivered email)', async () => {
    const row = await seedRow('Sent');
    const { status, json } = await callRetry({ id: row.id });
    assert.equal(status, 409, JSON.stringify(json));
    assert.match(json.error || '', /Sent/);

    const { data: after } = await service.from('email_queue').select('status, retry_count').eq('id', row.id).single();
    assert.equal(after.status, 'Sent');
    assert.equal(after.retry_count, 0);
  });

  test('refuses to retry a Pending row (that belongs to the bulk-drain path)', async () => {
    const row = await seedRow('Pending');
    const { status, json } = await callRetry({ id: row.id });
    assert.equal(status, 409, JSON.stringify(json));
  });

  // The double-click case. Two concurrent retries of the same row must not
  // both send - the function claims the row (Error -> Processing) and treats
  // "no rows updated" as the rejection, so exactly one caller proceeds.
  test('two concurrent retries of the same row: only one is accepted', async () => {
    const row = await seedRow('Error');

    const [a, b] = await Promise.all([
      callRetry({ id: row.id }),
      callRetry({ id: row.id }),
    ]);

    const accepted = [a, b].filter((r) => r.status === 200);
    const rejected = [a, b].filter((r) => r.status === 409);

    assert.equal(accepted.length, 1,
      `exactly one concurrent retry should be accepted, got ${accepted.length} ` +
      `(a: ${a.status}, b: ${b.status}) - two acceptances means the same email could be sent twice`);
    assert.equal(rejected.length, 1);

    // Ground truth: only one attempt was actually recorded.
    const { data: final } = await service.from('email_queue').select('retry_count').eq('id', row.id).single();
    assert.equal(final.retry_count, 1, 'exactly one send attempt should have been recorded');
  });
});

// NOTE: anon's table-level lockout on email_queue is deliberately NOT
// re-tested here — security.test.mjs's "email_queue is completely
// inaccessible to anon" already owns that, and the `anon` client in this file
// is signed in as the test admin by before(), so an anon assertion written
// against it would silently be testing the admin path instead.
