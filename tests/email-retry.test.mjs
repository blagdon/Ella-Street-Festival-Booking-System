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

  // The anti-double-send mechanism, tested at the level it actually operates.
  //
  // An earlier version of this test fired two concurrent retry HTTP calls and
  // asserted exactly one was accepted. That was wrong on two counts, and CI
  // caught it where a local run hadn't:
  //
  //  1. It asserted the wrong thing. With Zoho unconfigured the send fails
  //     fast, so the first call finishes its whole cycle (claim -> send fails
  //     -> status back to 'Error') before the second claims. The second then
  //     sees a genuinely-Error row and retries it - which is correct, desired
  //     behaviour, not a double-send. Retrying after a failure is the point.
  //  2. Even for a true overlap it would be unreliable: two HTTP round trips
  //     don't dependably land in the same microsecond window, exactly the
  //     false negative integration.test.mjs documents for booking_locations.
  //
  // So this exercises the claim primitive the function is built on instead:
  // a conditional Error -> Processing update where "no rows matched" is the
  // rejection. This IS deterministic, because nothing resets the status back
  // - once claimed, the row stays Processing, so the loser matches nothing no
  // matter how the two calls interleave.
  //
  // The real user-facing guarantee - a successfully delivered email is never
  // sent twice - is covered by the already-Sent test above: a successful send
  // leaves the row 'Sent', which is not claimable.
  test('the row claim is atomic: only one of two concurrent claims matches', async () => {
    const row = await seedRow('Error');

    const [c1, c2] = await Promise.all([
      service.from('email_queue').update({ status: 'Processing' }).eq('id', row.id).eq('status', 'Error').select(),
      service.from('email_queue').update({ status: 'Processing' }).eq('id', row.id).eq('status', 'Error').select(),
    ]);

    const winners = [c1, c2].filter((r) => (r.data || []).length > 0);
    assert.equal(winners.length, 1,
      `exactly one concurrent claim should match, got ${winners.length} - ` +
      `two winners would mean two callers could both proceed to send the same email`);
  });

  test('a retry that fails again leaves the row retryable (not stuck in Processing)', async () => {
    const row = await seedRow('Error');
    await callRetry({ id: row.id });

    const { data: afterFirst } = await service.from('email_queue').select('status').eq('id', row.id).single();
    assert.equal(afterFirst.status, 'Error',
      'a failed retry must return the row to Error so the admin can try again, not strand it in Processing');

    const { status } = await callRetry({ id: row.id });
    assert.equal(status, 200, 'a row that failed again must still be retryable');
  });
});

// NOTE: anon's table-level lockout on email_queue is deliberately NOT
// re-tested here — security.test.mjs's "email_queue is completely
// inaccessible to anon" already owns that, and the `anon` client in this file
// is signed in as the test admin by before(), so an anon assertion written
// against it would silently be testing the admin path instead.
