// Integration test for SMS Test Mode — the master switch added alongside
// The SMS Works integration (migration 20260728090000, _shared/sms.ts's
// sendViaSms(), settings.html's "SMS (The SMS Works)" card).
//
// Unlike tests/sms-send.test.mjs, THIS FILE deliberately points sms_provider
// away from 'mock' for the duration of its own tests — that is exactly the
// scenario Test Mode exists to make safe, so it has to be exercised here.
// The risk that guards against is real (a genuine external HTTP call to a
// live SMS provider from a test run), so the "real" provider used in these
// tests is pointed at 127.0.0.1:1 — a port nothing listens on. A connection
// there fails instantly (ECONNREFUSED) rather than ever reaching a real
// endpoint, so even a total bug in the test-mode override logic cannot
// result in a real message going anywhere.
//
// sms_provider (and every setting this file touches) is restored to its
// original value in `after()`, via try/finally around the mutating section,
// so tests/sms-send.test.mjs's own safety interlock ("sms_provider must be
// 'mock'") holds true again for every run after this one.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, adminEmail, adminPassword, service, callEdgeFunction } from './helpers.mjs';

const anon = createClient(url, anonKey);

// Deliberately unroutable — see file header. Ofcom-reserved drama number for
// the recipient, same convention as sms-send.test.mjs.
const UNREACHABLE_URL = 'http://127.0.0.1:1/message/send';
const SEND_TO = '07700 900177';
const SEND_TO_E164 = '+447700900177';

const TOUCHED_KEYS = ['sms_provider', 'sms_api_url', 'sms_api_key', 'sms_sender_id', 'sms_test_mode'];
let originalSettings = {};
let adminToken;

before(async () => {
  const { data, error } = await anon.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${error.message}`);
  adminToken = data.session.access_token;

  // Snapshot whatever's currently there so after() can restore it exactly,
  // rather than assuming what "the original state" was.
  const { data: rows, error: fetchErr } = await service.from('settings').select('key, value').in('key', TOUCHED_KEYS);
  if (fetchErr) throw fetchErr;
  originalSettings = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));

  await service.from('sms_queue').delete().eq('recipient', SEND_TO_E164);
});

after(async () => {
  // Restore every touched key to its pre-test value (or delete it if it
  // didn't exist before) — this is what keeps sms-send.test.mjs's "provider
  // must be mock" interlock valid for every subsequent run.
  for (const key of TOUCHED_KEYS) {
    if (key in originalSettings) {
      await service.from('settings').upsert({ org_id: 'org_default', key, value: originalSettings[key], updated_by: 'test-restore' }, { onConflict: 'org_id,key' });
    } else {
      await service.from('settings').delete().eq('key', key);
    }
  }
  await service.from('sms_queue').delete().eq('recipient', SEND_TO_E164);
});

function callSend(body) {
  return callEdgeFunction('send-sms', body, adminToken);
}

async function setSettings(overrides) {
  const rows = Object.entries(overrides).map(([key, value]) => ({ org_id: 'org_default', key, value, updated_by: 'test' }));
  const { error } = await service.from('settings').upsert(rows, { onConflict: 'org_id,key' });
  if (error) throw error;
}

describe('SMS Test Mode override', () => {
  test('Test Mode ON short-circuits to mock even when sms_provider names a real provider with unreachable settings', async () => {
    await setSettings({
      sms_provider: 'thesmsworks',
      sms_api_url: UNREACHABLE_URL,
      sms_api_key: 'not-a-real-key',
      sms_sender_id: 'TestSender',
      sms_test_mode: 'true',
    });

    const { status, json } = await callSend({ recipient: SEND_TO, body: 'Test Mode ON check' });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.success, true, 'Test Mode must make the send succeed via mock, never attempt the unreachable URL');
    assert.equal(json.status, 'Sent');
    assert.match(json.provider_message_id || '', /^mock-/,
      'a mock- prefixed id proves this went through the mock adapter, not the (unreachable) configured provider');
  });

  test('Test Mode OFF genuinely uses the configured provider (proven by it then failing against the unreachable URL)', async () => {
    await setSettings({
      sms_provider: 'thesmsworks',
      sms_api_url: UNREACHABLE_URL,
      sms_api_key: 'not-a-real-key',
      sms_sender_id: 'TestSender',
      sms_test_mode: 'false',
    });

    const { status, json } = await callSend({ recipient: SEND_TO, body: 'Test Mode OFF check' });
    // A connection failure to the (deliberately unreachable) URL is exactly
    // the proof this test needs: the override did NOT route to mock, it
    // genuinely tried the configured provider. send-sms reports this as a
    // failed send (502), not a 5xx crash.
    assert.equal(status, 502, JSON.stringify(json));
    assert.equal(json.success, false);
    assert.ok(json.error_message, 'expected a connection-failure message from the unreachable URL attempt');

    const { data: rows } = await service.from('sms_queue')
      .select('status, provider_message_id').eq('recipient', SEND_TO_E164)
      .order('id', { ascending: false }).limit(1);
    assert.equal(rows[0].status, 'Error');
    assert.equal(rows[0].provider_message_id, null, 'a failed real-provider attempt must not carry a mock- id');
  });

  test('an absent sms_test_mode setting defaults to ON (safe by default)', async () => {
    await setSettings({
      sms_provider: 'thesmsworks',
      sms_api_url: UNREACHABLE_URL,
      sms_api_key: 'not-a-real-key',
      sms_sender_id: 'TestSender',
    });
    await service.from('settings').delete().eq('key', 'sms_test_mode');

    const { status, json } = await callSend({ recipient: SEND_TO, body: 'Default (absent) test mode check' });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.success, true, 'an absent sms_test_mode row must behave as Test Mode ON, not OFF');
    assert.match(json.provider_message_id || '', /^mock-/);
  });
});
