// Integration tests for check-sms-delivery — the on-demand "did this text
// actually reach the handset" check added after a live bulk send showed 3
// rows as Sent but only 2 texts arrived. sms_queue.status only ever meant
// "did the API call to the provider succeed"; this adds a separate,
// independent delivery_status the admin can check per message.
//
// Like tests/sms-test-mode.test.mjs, THIS FILE deliberately points
// sms_provider away from 'mock' for some of its tests (checking delivery
// only makes sense for a real provider) — snapshotted and restored in
// after(), verified by re-running tests/sms-send.test.mjs afterwards to
// confirm its "sms_provider must be mock" interlock still holds.
//
// The "real provider" tests use the same 127.0.0.1:1-is-always-refused trick
// as sms-test-mode.test.mjs: sms_api_url is set to an unreachable send URL,
// which _shared/sms.ts's checkDeliveryStatus() derives a matching unreachable
// status-check URL from — so even a bug in that derivation can only ever hit
// a local, always-closed port, never a real endpoint.
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

// Matches sendViaTheSmsWorks' expected shape (".../message/send"); checkDeliveryStatus
// derives ".../messages/{id}" from this by swapping the known suffix.
const UNREACHABLE_SEND_URL = 'http://127.0.0.1:1/message/send';

const TOUCHED_KEYS = ['sms_provider', 'sms_api_url', 'sms_api_key'];
let originalSettings = {};
let adminToken;

async function insertRow(overrides = {}) {
  const { data, error } = await service.from('sms_queue').insert({
    recipient: '+447700900188',
    body: 'delivery status test',
    status: 'Sent',
    ...overrides,
  }).select().single();
  assert.equal(error, null, error?.message);
  return data;
}

before(async () => {
  const { data, error } = await anon.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${error.message}`);
  adminToken = data.session.access_token;

  const { data: rows, error: fetchErr } = await service.from('settings').select('key, value').in('key', TOUCHED_KEYS);
  if (fetchErr) throw fetchErr;
  originalSettings = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));

  await service.from('sms_queue').delete().eq('recipient', '+447700900188');
});

after(async () => {
  for (const key of TOUCHED_KEYS) {
    if (key in originalSettings) {
      await service.from('settings').upsert({ key, value: originalSettings[key], updated_by: 'test-restore' });
    } else {
      await service.from('settings').delete().eq('key', key);
    }
  }
  await service.from('sms_queue').delete().eq('recipient', '+447700900188');
});

async function callCheck(body) {
  const res = await fetch(`${url}/functions/v1/check-sms-delivery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`, apikey: anonKey },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function setSettings(overrides) {
  const rows = Object.entries(overrides).map(([key, value]) => ({ key, value, updated_by: 'test' }));
  const { error } = await service.from('settings').upsert(rows);
  if (error) throw error;
}

describe('check-sms-delivery', () => {
  test('rejects an unauthenticated caller', async () => {
    const row = await insertRow({ provider_message_id: 'mock-does-not-matter' });
    const res = await fetch(`${url}/functions/v1/check-sms-delivery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}`, apikey: anonKey },
      body: JSON.stringify({ id: row.id }),
    });
    assert.equal(res.status, 401);
  });

  test('rejects a non-numeric id', async () => {
    const { status } = await callCheck({ id: 'not-a-number' });
    assert.equal(status, 400);
  });

  test('returns 404 for an id that does not exist', async () => {
    const { status } = await callCheck({ id: 2147483600 });
    assert.equal(status, 404);
  });

  test('skips cleanly for a simulated (mock-) send, with no attempt to check anything', async () => {
    const row = await insertRow({ provider_message_id: `mock-${crypto.randomUUID()}` });
    const { status, json } = await callCheck({ id: row.id });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.skipped, true);
    assert.match(json.reason || '', /simulated/i);

    const { data: after } = await service.from('sms_queue').select('delivery_status, delivery_checked_at').eq('id', row.id).single();
    assert.equal(after.delivery_status, null, 'a skipped check must not write a delivery_status');
    assert.equal(after.delivery_checked_at, null);
  });

  test('skips cleanly for a row with no provider_message_id', async () => {
    const row = await insertRow({ provider_message_id: null });
    const { status, json } = await callCheck({ id: row.id });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.skipped, true);
  });

  test('throws a clear error when sms_provider is not thesmsworks', async () => {
    await setSettings({ sms_provider: 'mock' });
    const row = await insertRow({ provider_message_id: 'real-looking-id-12345' });

    const { status, json } = await callCheck({ id: row.id });
    assert.equal(status, 500, JSON.stringify(json));
    assert.match(json.error || '', /only implemented for The SMS Works/);
  });

  test('genuinely attempts a live check against the configured provider, and fails cleanly when unreachable', async () => {
    await setSettings({
      sms_provider: 'thesmsworks',
      sms_api_url: UNREACHABLE_SEND_URL,
      sms_api_key: 'not-a-real-key',
    });
    const row = await insertRow({ provider_message_id: 'real-looking-id-67890' });

    const { status, json } = await callCheck({ id: row.id });
    // A connection failure to the deliberately unreachable URL is the proof
    // this test needs: the function did not silently skip, it genuinely
    // tried to reach a provider — 500 (thrown inside checkDeliveryStatus),
    // not skipped:true.
    assert.equal(status, 500, JSON.stringify(json));
    assert.equal(json.skipped, undefined);
    assert.ok(json.error, 'expected a connection-failure message from the unreachable URL attempt');

    const { data: after } = await service.from('sms_queue').select('delivery_status, delivery_checked_at').eq('id', row.id).single();
    assert.equal(after.delivery_status, null, 'a failed check must not write a stale/wrong delivery_status');
  });
});
