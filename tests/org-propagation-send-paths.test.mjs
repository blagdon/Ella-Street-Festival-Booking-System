// Regression tests for the Org-Propagation Gap fix across five external send
// paths: retry-queued-sms, retry-queued-email, queue-bulk-sms,
// queue-bulk-email, and send-email's default action.
//
// Each of these already correctly authorized its RESOURCE LOOKUP (the queue
// row it claimed, or the booking it re-derived recipients from) against the
// caller's own organisation scope — that part was never the bug. The bug was
// one step further down: having authorized the resource, none of them then
// passed that resource's own org_id into the actual sendViaSms()/
// sendViaZoho() call, so the send itself silently used org_default's
// provider credentials regardless of which organisation the resource
// actually belonged to.
//
// Fixed by threading the resource's own org_id into every downstream send
// call:
//   - retry-queued-sms / retry-queued-email: the already-claimed queue row's
//     own org_id (it was already selected via .select(), just never used).
//   - queue-bulk-sms / queue-bulk-email: PER-ROW inside the background drain
//     loop, never a single request-level variable — a single drain batch can
//     legitimately span bookings from multiple organisations.
//   - send-email's default action: given the same validated-orgId
//     resolution send-sms already had (E5-26) — isTrustedServiceCall /
//     isAuthorizedForOrg / platformAdmin fallback / single-org fallback /
//     ambiguous rejection — plus js/api.js's sendEmailDirect()/
//     sendEmailViaZoho() now actually thread the orgId sendEmailDirect
//     already computes (from the target booking, via sendEmail()) through to
//     the Edge Function, instead of silently dropping it before the HTTP
//     call as before.
//
// PROVING PROVIDER SELECTION WITHOUT A REAL EXTERNAL SEND:
//  - SMS: each throwaway organisation below is configured with its own,
//    uniquely-named bogus sms_provider value. _shared/sms.ts validates the
//    configured provider name against its adapter table BEFORE consulting
//    sms_test_mode, so loading the WRONG organisation's settings produces an
//    "Unknown sms_provider" error containing that (wrong) organisation's own
//    sentinel string — a purely local, deterministic proof with no network
//    call at all.
//  - Email: Org A is left entirely unconfigured for Zoho (throws the
//    distinct, local "Missing required Zoho API configuration settings"
//    error), Org B is given a full but fake configuration pointed at
//    https://example.invalid (RFC 2606, guaranteed to never resolve — same
//    convention as tests/send-email-tenant-isolation.test.mjs) — a genuine
//    network-level failure, but one that can never reach a real Zoho server
//    or send a real email. Reading the WRONG organisation's config for a
//    given row therefore always flips which of the two failure shapes comes
//    back, so a "reused one organisation's config for every row" bug is
//    caught regardless of processing order within a batch.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, adminEmail, adminPassword, service, callEdgeFunction } from './helpers.mjs';

function genTestPassword() {
  return randomUUID() + randomUUID().slice(0, 8).toUpperCase() + '!';
}

const RUN_ID = Date.now();
const ORG_A = `orgprop-a-${RUN_ID}`;
const ORG_B = `orgprop-b-${RUN_ID}`;
const OWNER_A_EMAIL = `orgprop-owner-a-${RUN_ID}@example.test`;
const OWNER_A_PASSWORD = genTestPassword();

const SMS_PROVIDER_SENTINEL_A = `sentinel-unknown-provider-a-${RUN_ID}`;
const SMS_PROVIDER_SENTINEL_B = `sentinel-unknown-provider-b-${RUN_ID}`;

// RFC 2606 — reserved, guaranteed to never resolve. Same convention as
// tests/send-email-tenant-isolation.test.mjs.
const UNREACHABLE_DOMAIN = 'https://example.invalid';

const MISSING_ZOHO_CONFIG = /Missing required Zoho API configuration/;

let ownerAId;
let ownerA, platformAdmin;

async function tokenFor(client) {
  const { data } = await client.auth.getSession();
  return data.session.access_token;
}

async function pollUntilResolved(table, id, { timeoutMs = 45000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const { data } = await service.from(table).select('status, error_message').eq('id', id).single();
    last = data;
    if (data && data.status !== 'Pending' && data.status !== 'Processing') return data;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${table} row ${id} to leave Pending/Processing (last seen: ${JSON.stringify(last)})`);
}

async function insertBooking(id, overrides = {}) {
  // event_id is incidental to this file's purpose (proving org_id reaches
  // the right send-provider config) - every call site below supplies its
  // own org_id explicitly via overrides, but none needs a distinct event,
  // so this stays 'event_default' explicitly rather than fabricating a
  // per-org event this file otherwise has no use for.
  const { error } = await service.from('bookings').insert({
    id,
    event_id: 'event_default',
    status: 'Confirmed',
    business_name: `Org Propagation Test ${id}`,
    owner_name: 'Org Propagation Tester',
    instance_prefix: 'ESF26-DEV-',
    stall_type: 'Food',
    ...overrides,
  });
  if (error) throw new Error(`Fixture setup failed for ${id}: ${error.message}`);
}

before(async () => {
  // Safety/correctness interlock, mirroring tests/sms-send.test.mjs's own
  // "sms_provider must be mock" guard. Several assertions below rely on
  // org_default having NO Zoho configuration in this test project (the same
  // deliberate state tests/rejection.test.mjs and tests/location-email.test.mjs
  // already depend on) to prove the fix resolves to the caller-supplied Org
  // A/B, not a coincidentally-successful org_default fallback.
  const { data: existingZohoClientId } = await service.from('settings')
    .select('value').eq('org_id', 'org_default').eq('key', 'zoho_client_id').maybeSingle();
  if (existingZohoClientId) {
    throw new Error('Refusing to run: org_default has a configured zoho_client_id in this test project - these tests assume it is unconfigured.');
  }

  const { error: orgAErr } = await service.from('organisations')
    .insert({ id: ORG_A, name: `Org Propagation Test ${ORG_A}`, slug: ORG_A, contact_email: 'owner@example.test' });
  assert.equal(orgAErr, null, orgAErr?.message);
  const { error: orgBErr } = await service.from('organisations')
    .insert({ id: ORG_B, name: `Org Propagation Test ${ORG_B}`, slug: ORG_B, contact_email: 'owner@example.test' });
  assert.equal(orgBErr, null, orgBErr?.message);

  // Org A: SMS uses a bogus, uniquely-named provider (fails locally, no
  // network). Zoho is left entirely unconfigured (fails with the distinct
  // "missing config" error).
  const { error: settingsAErr } = await service.from('settings').upsert([
    { org_id: ORG_A, key: 'sms_provider', value: SMS_PROVIDER_SENTINEL_A },
  ], { onConflict: 'org_id,key' });
  assert.equal(settingsAErr, null, settingsAErr?.message);

  // Org B: SMS same shape, its own sentinel. Zoho given a full but fake
  // configuration pointed at example.invalid, so a send genuinely attempts
  // the network and fails there — never reaching a real Zoho server, but
  // producing a distinctly different failure shape than Org A's.
  const { error: settingsBErr } = await service.from('settings').upsert([
    { org_id: ORG_B, key: 'sms_provider', value: SMS_PROVIDER_SENTINEL_B },
    { org_id: ORG_B, key: 'zoho_client_id', value: 'fake-client-id' },
    { org_id: ORG_B, key: 'zoho_client_secret', value: 'fake-client-secret' },
    { org_id: ORG_B, key: 'zoho_refresh_token', value: 'fake-refresh-token' },
    { org_id: ORG_B, key: 'zoho_account_id', value: 'fake-account-id' },
    { org_id: ORG_B, key: 'zoho_accounts_domain', value: UNREACHABLE_DOMAIN },
    { org_id: ORG_B, key: 'zoho_api_domain', value: UNREACHABLE_DOMAIN },
  ], { onConflict: 'org_id,key' });
  assert.equal(settingsBErr, null, settingsBErr?.message);

  // Owner A — a real admin of Org A only, never org_default, never Org B.
  // Used to prove a tenant admin cannot forge orgId to reach another
  // organisation's configuration (send-email Test 3), and that omitting
  // orgId falls back to the caller's own single organisation (Test 4).
  const { data: ownerACreated, error: ownerAErr } = await service.auth.admin.createUser({
    email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD, email_confirm: true,
  });
  assert.equal(ownerAErr, null, ownerAErr?.message);
  ownerAId = ownerACreated.user.id;
  const { error: memberAErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_A, user_id: ownerAId, role: 'admin' });
  assert.equal(memberAErr, null, memberAErr?.message);

  ownerA = createClient(url, anonKey);
  const { error: signInAErr } = await ownerA.auth.signInWithPassword({ email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD });
  assert.equal(signInAErr, null, signInAErr?.message);

  platformAdmin = createClient(url, anonKey);
  const { error: platformSignInErr } = await platformAdmin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  assert.equal(platformSignInErr, null, platformSignInErr?.message);
});

after(async () => {
  await service.from('sms_queue').delete().in('org_id', [ORG_A, ORG_B]);
  await service.from('email_queue').delete().in('org_id', [ORG_A, ORG_B]);
  await service.from('bookings').delete().like('id', `%-ORGPROP-%-${RUN_ID}`);
  await service.from('settings').delete().in('org_id', [ORG_A, ORG_B]);
  await service.from('organisation_members').delete().in('org_id', [ORG_A, ORG_B]);
  await service.from('organisations').delete().in('id', [ORG_A, ORG_B]);
  if (ownerAId) await service.auth.admin.deleteUser(ownerAId);
});

describe('retry-queued-sms: a retried row uses ITS OWN organisation\'s SMS provider, not org_default\'s', () => {
  test('Org A row resolves Org A\'s own (sentinel) provider', async () => {
    const { data: row, error } = await service.from('sms_queue').insert({
      recipient: '+447700900450', body: 'org propagation retry test A', status: 'Error',
      error_message: 'original failure', org_id: ORG_A,
    }).select().single();
    assert.equal(error, null, error?.message);

    const { status, json } = await callEdgeFunction('retry-queued-sms', { id: row.id }, await tokenFor(platformAdmin));
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.success, false);
    assert.match(json.error_message || '', new RegExp(SMS_PROVIDER_SENTINEL_A),
      'the retry must load Org A\'s own sms_provider setting, proving row.org_id reached sendViaSms()');
  });

  test('Org B row resolves Org B\'s own (sentinel) provider (not Org A\'s, not a hardcoded org)', async () => {
    const { data: row, error } = await service.from('sms_queue').insert({
      recipient: '+447700900451', body: 'org propagation retry test B', status: 'Error',
      error_message: 'original failure', org_id: ORG_B,
    }).select().single();
    assert.equal(error, null, error?.message);

    const { status, json } = await callEdgeFunction('retry-queued-sms', { id: row.id }, await tokenFor(platformAdmin));
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.success, false);
    assert.match(json.error_message || '', new RegExp(SMS_PROVIDER_SENTINEL_B),
      'the retry must load Org B\'s own sms_provider setting, proving row.org_id reached sendViaSms()');
  });
});

describe('retry-queued-email: a retried row uses ITS OWN organisation\'s Zoho configuration, not org_default\'s', () => {
  test('Org A (unconfigured) row fails with Org A\'s own "missing config" error', async () => {
    const { data: row, error } = await service.from('email_queue').insert({
      recipient: 'orgprop-retry-a@example.test', subject: 'x', body: 'x', status: 'Error',
      error_message: 'original failure', org_id: ORG_A,
    }).select().single();
    assert.equal(error, null, error?.message);

    const { status, json } = await callEdgeFunction('retry-queued-email', { id: row.id }, await tokenFor(platformAdmin));
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.success, false);
    assert.match(json.error_message || '', MISSING_ZOHO_CONFIG,
      'Org A has no Zoho configuration at all, so a retry attributed to Org A must fail with the "missing config" error - proving row.org_id (not org_default) was used');
  });

  test('Org B (configured) row genuinely attempts Org B\'s own network configuration, a different failure shape', async () => {
    const { data: row, error } = await service.from('email_queue').insert({
      recipient: 'orgprop-retry-b@example.test', subject: 'x', body: 'x', status: 'Error',
      error_message: 'original failure', org_id: ORG_B,
    }).select().single();
    assert.equal(error, null, error?.message);

    const { status, json } = await callEdgeFunction('retry-queued-email', { id: row.id }, await tokenFor(platformAdmin));
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.success, false);
    assert.doesNotMatch(json.error_message || '', MISSING_ZOHO_CONFIG,
      'Org B has its own (fake but present) Zoho configuration, so the retry must fail differently than the "missing config" (Org A / org_default) shape');
  });
});

describe('queue-bulk-sms: per-row org-propagation in a mixed-organisation batch', () => {
  const BOOKING_A = `ESF26-ORGPROP-SMSA-${RUN_ID}`;
  const BOOKING_B = `ESF26-ORGPROP-SMSB-${RUN_ID}`;
  const PHONE_A = '+447700900452';
  const PHONE_B = '+447700900453';

  before(async () => {
    await insertBooking(BOOKING_A, { phone: PHONE_A, org_id: ORG_A });
    await insertBooking(BOOKING_B, { phone: PHONE_B, org_id: ORG_B });
  });
  after(async () => {
    await service.from('bookings').delete().in('id', [BOOKING_A, BOOKING_B]);
  });

  test('a single bulk send spanning two organisations attributes each send to its OWN organisation\'s provider, never a shared/global one', async () => {
    const { status, json } = await callEdgeFunction('queue-bulk-sms',
      { bookingIds: [BOOKING_A, BOOKING_B], body: 'org propagation bulk sms test' },
      await tokenFor(platformAdmin));
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.queued, 2, JSON.stringify(json));

    const { data: rows } = await service.from('sms_queue').select('id, recipient').in('recipient', [PHONE_A, PHONE_B]);
    const rowA = rows.find((r) => r.recipient === PHONE_A);
    const rowB = rows.find((r) => r.recipient === PHONE_B);
    assert.ok(rowA && rowB, `expected both queued rows, got ${JSON.stringify(rows)}`);

    const [resolvedA, resolvedB] = await Promise.all([
      pollUntilResolved('sms_queue', rowA.id),
      pollUntilResolved('sms_queue', rowB.id),
    ]);

    assert.match(resolvedA.error_message || '', new RegExp(SMS_PROVIDER_SENTINEL_A),
      'Org A\'s booking send must use Org A\'s own sms_provider, not Org B\'s or a shared default - this is exactly the bug class a single request-level org variable would produce');
    assert.match(resolvedB.error_message || '', new RegExp(SMS_PROVIDER_SENTINEL_B),
      'Org B\'s booking send must use Org B\'s own sms_provider, not Org A\'s or a shared default');
  });
});

describe('queue-bulk-email: per-row org-propagation in a mixed-organisation batch', () => {
  const BOOKING_A = `ESF26-ORGPROP-EMAILA-${RUN_ID}`;
  const BOOKING_B = `ESF26-ORGPROP-EMAILB-${RUN_ID}`;
  const RECIPIENT_A = `orgprop-bulk-email-a-${RUN_ID}@example.test`;
  const RECIPIENT_B = `orgprop-bulk-email-b-${RUN_ID}@example.test`;

  before(async () => {
    await insertBooking(BOOKING_A, { email: RECIPIENT_A, org_id: ORG_A });
    await insertBooking(BOOKING_B, { email: RECIPIENT_B, org_id: ORG_B });
  });
  after(async () => {
    await service.from('bookings').delete().in('id', [BOOKING_A, BOOKING_B]);
  });

  test('a single bulk send spanning two organisations attributes each send to its OWN organisation\'s Zoho configuration, never a shared/global one', async () => {
    const { status, json } = await callEdgeFunction('queue-bulk-email',
      { bookingIds: [BOOKING_A, BOOKING_B], subject: 'Org propagation bulk email test', body: 'test body' },
      await tokenFor(platformAdmin));
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.queued, 2, JSON.stringify(json));

    const { data: rows } = await service.from('email_queue').select('id, recipient').in('recipient', [RECIPIENT_A, RECIPIENT_B]);
    const rowA = rows.find((r) => r.recipient === RECIPIENT_A);
    const rowB = rows.find((r) => r.recipient === RECIPIENT_B);
    assert.ok(rowA && rowB, `expected both queued rows, got ${JSON.stringify(rows)}`);

    const [resolvedA, resolvedB] = await Promise.all([
      pollUntilResolved('email_queue', rowA.id),
      pollUntilResolved('email_queue', rowB.id),
    ]);

    assert.match(resolvedA.error_message || '', MISSING_ZOHO_CONFIG,
      'Org A has no Zoho configuration, so its own booking send must fail with the "missing config" error, not Org B\'s configured-domain failure - this is exactly the bug class a single request-level org variable would produce');
    assert.doesNotMatch(resolvedB.error_message || '', MISSING_ZOHO_CONFIG,
      'Org B has its own (fake but present) Zoho configuration, so its own booking send must genuinely attempt the network, not fall back to the "missing config" shape');
  });
});

describe('send-email default action: org-propagation and validated orgId (mirrors send-sms, E5-26)', () => {
  test('Test 1 - an orgId pointing at Org A (unconfigured) fails with Org A\'s own "missing config" error', async () => {
    const { status, json } = await callEdgeFunction('send-email',
      { recipient: 'orgprop-e1@example.test', subject: 'x', body: 'x', orgId: ORG_A },
      await tokenFor(platformAdmin));
    assert.equal(status, 500, JSON.stringify(json));
    assert.match(json.error || '', MISSING_ZOHO_CONFIG,
      'Org A has no Zoho configuration, proving the supplied orgId (not org_default) reached sendViaZoho()');
  });

  test('Test 2 - an orgId pointing at Org B (configured) genuinely attempts Org B\'s own network configuration', async () => {
    const { status, json } = await callEdgeFunction('send-email',
      { recipient: 'orgprop-e2@example.test', subject: 'x', body: 'x', orgId: ORG_B },
      await tokenFor(platformAdmin));
    assert.notEqual(status, 200, JSON.stringify(json));
    assert.doesNotMatch(json.error || '', MISSING_ZOHO_CONFIG,
      'Org B has its own configuration, so the send must fail differently than the "missing config" (Org A / org_default) shape - proving the resolved orgId genuinely selected Org B\'s own settings, which is also the platform-admin-acting-on-another-organisation\'s-resource case');
  });

  test('Test 3 (critical regression test) - a tenant admin CANNOT forge orgId to reach another organisation\'s Zoho configuration', async () => {
    const { status, json } = await callEdgeFunction('send-email',
      { recipient: 'orgprop-e3@example.test', subject: 'x', body: 'x', orgId: ORG_B },
      await tokenFor(ownerA));
    assert.equal(status, 403, `cross-tenant orgId must be rejected, got ${status}: ${JSON.stringify(json)}`);
  });

  test('Test 4 - omitting orgId falls back to the caller\'s own single organisation, never a client-influenced value', async () => {
    const { status, json } = await callEdgeFunction('send-email',
      { recipient: 'orgprop-e4@example.test', subject: 'x', body: 'x' },
      await tokenFor(ownerA));
    assert.equal(status, 500, JSON.stringify(json));
    assert.match(json.error || '', MISSING_ZOHO_CONFIG,
      'omitting orgId must resolve to the caller\'s own organisation (Org A, unconfigured), not org_default');
  });

  test('Test 5 (regression guard) - a genuine platform admin with no orgId still resolves to org_default, unchanged from before this fix', async () => {
    const { status, json } = await callEdgeFunction('send-email',
      { recipient: 'orgprop-e5@example.test', subject: 'x', body: 'x' },
      await tokenFor(platformAdmin));
    assert.equal(status, 500, JSON.stringify(json));
    assert.match(json.error || '', MISSING_ZOHO_CONFIG,
      'org_default is deliberately unconfigured for Zoho in this test project - a platform admin with no orgId must still resolve to org_default, exactly as before this fix');
  });

  test('Test 6 - an unauthenticated caller is rejected', async () => {
    const { status, json } = await callEdgeFunction('send-email',
      { recipient: 'orgprop-e6@example.test', subject: 'x', body: 'x', orgId: ORG_A }, anonKey);
    assert.equal(status, 401, JSON.stringify(json));
  });
});
