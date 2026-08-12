// Regression tests for E5-18: check-sms-delivery checked admin status
// against the global user_roles table (any org's admin, not org-scoped)
// and looked up the target sms_queue row by id alone, with no org filter —
// so an admin of Organisation A, given Organisation B's sms_queue id
// (sms_queue.id is a plain sequential bigint, trivially enumerable), could
// read and overwrite Organisation B's SMS delivery-status metadata
// (provider_message_id, delivery_status, delivery_checked_at,
// delivery_failure_reason).
//
// Fixed in supabase/functions/check-sms-delivery/index.ts by:
//   1. Replacing the user_roles check with resolveCallerAdminScope()
//      (mirrors retry-queued-sms/get-booking-documents/create-checkout-session).
//   2. Selecting org_id on the row and scoping the lookup query itself to
//      the caller's org set — a cross-tenant id now reads as a plain 404,
//      never confirming the row exists in another org. The subsequent
//      delivery-status UPDATE reuses that same already-authorised id, so it
//      inherits the same boundary without needing its own separate filter.
//
// Deliberately never touches the global sms_provider/sms_api_url/sms_api_key
// settings this suite has already flagged as a real cross-file contention
// risk (see sms-test-mode.test.mjs / sms-delivery-status.test.mjs) — every
// fixture row here uses a mock-prefixed provider_message_id, which takes
// the safe "skipped" response path and fully proves the authorization
// boundary without depending on (or racing) any provider configuration.
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
const ORG_A = `e518-org-a-${RUN_ID}`;
const ORG_B = `e518-org-b-${RUN_ID}`;
const OWNER_A_EMAIL = `e518-owner-a-${RUN_ID}@example.test`;
const OWNER_A_PASSWORD = genTestPassword();
const STEWARD_A_EMAIL = `e518-steward-a-${RUN_ID}@example.test`;
const STEWARD_A_PASSWORD = genTestPassword();

const RECIPIENT_A = '+447700900201';
const RECIPIENT_B = '+447700900202';

let ownerAId, stewardAId;
let ownerA, stewardA, platformAdmin;
let rowAId, rowBId;

async function seedOrgWithRow(orgId, recipient) {
  const { error: orgErr } = await service.from('organisations')
    .insert({ id: orgId, name: `E5-18 Test ${orgId}`, slug: orgId, contact_email: 'owner@example.test' });
  assert.equal(orgErr, null, orgErr?.message);

  const { data: row, error: rowErr } = await service.from('sms_queue').insert({
    org_id: orgId, recipient, body: 'E5-18 test message', status: 'Sent',
    provider_message_id: `mock-${randomUUID()}`,
  }).select('id').single();
  assert.equal(rowErr, null, rowErr?.message);
  return row.id;
}

async function cleanupOrg(orgId, rowId) {
  await service.from('sms_queue').delete().eq('id', rowId);
  await service.from('organisation_members').delete().eq('org_id', orgId);
  await service.from('organisations').delete().eq('id', orgId);
}

async function tokenFor(client) {
  const { data } = await client.auth.getSession();
  return data.session.access_token;
}

before(async () => {
  rowAId = await seedOrgWithRow(ORG_A, RECIPIENT_A);
  rowBId = await seedOrgWithRow(ORG_B, RECIPIENT_B);

  const { data: ownerCreated, error: ownerErr } = await service.auth.admin.createUser({
    email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD, email_confirm: true,
  });
  assert.equal(ownerErr, null, ownerErr?.message);
  ownerAId = ownerCreated.user.id;
  // A real admin of ORG_A only - never org_default, never ORG_B. Also given
  // a user_roles row, matching exactly what rpc_add_organisation_member()
  // writes for every real admin invited through the normal flow - without
  // it, this fixture wouldn't reach the OLD (pre-fix) global user_roles
  // admin check at all, which would make "this test fails against the
  // vulnerable implementation" untrue for an unrelated reason.
  const { error: memberErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_A, user_id: ownerAId, role: 'admin' });
  assert.equal(memberErr, null, memberErr?.message);
  const { error: legacyRoleErr } = await service.from('user_roles')
    .insert({ id: ownerAId, email: OWNER_A_EMAIL, role: 'admin' });
  assert.equal(legacyRoleErr, null, legacyRoleErr?.message);

  ownerA = createClient(url, anonKey);
  const { error: signInErr } = await ownerA.auth.signInWithPassword({ email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD });
  assert.equal(signInErr, null, signInErr?.message);

  const { data: stewardCreated, error: stewardErr } = await service.auth.admin.createUser({
    email: STEWARD_A_EMAIL, password: STEWARD_A_PASSWORD, email_confirm: true,
  });
  assert.equal(stewardErr, null, stewardErr?.message);
  stewardAId = stewardCreated.user.id;
  const { error: stewardMemberErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_A, user_id: stewardAId, role: 'steward' });
  assert.equal(stewardMemberErr, null, stewardMemberErr?.message);

  stewardA = createClient(url, anonKey);
  const { error: stewardSignInErr } = await stewardA.auth.signInWithPassword({ email: STEWARD_A_EMAIL, password: STEWARD_A_PASSWORD });
  assert.equal(stewardSignInErr, null, stewardSignInErr?.message);

  platformAdmin = createClient(url, anonKey);
  const { error: platformSignInErr } = await platformAdmin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  assert.equal(platformSignInErr, null, platformSignInErr?.message);
});

after(async () => {
  await cleanupOrg(ORG_A, rowAId);
  await cleanupOrg(ORG_B, rowBId);
  if (ownerAId) { await service.from('user_roles').delete().eq('id', ownerAId); await service.auth.admin.deleteUser(ownerAId); }
  if (stewardAId) await service.auth.admin.deleteUser(stewardAId);
});

describe('E5-18: check-sms-delivery cross-tenant authorization', () => {
  test('Test 1 - Org A\'s own admin can check delivery status on Org A\'s own row', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('check-sms-delivery', { id: rowAId }, token);

    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.skipped, true, 'a mock-prefixed provider id must take the safe skipped path');
    assert.match(json.reason || '', /simulated/i);
  });

  test('Test 2 (critical regression test) - an Org A admin CANNOT check or overwrite Org B\'s SMS delivery status', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('check-sms-delivery', { id: rowBId }, token);

    // Rejected before any row data is returned or mutated: a plain 404 (not
    // visible in the caller's own org scope), not a 200 that would leak
    // Org B's provider_message_id/skipped-reason or confirm the row exists
    // in another organisation.
    assert.equal(status, 404, `cross-tenant SMS delivery check must be rejected as not-found, got ${status}: ${JSON.stringify(json)}`);
    assert.equal(json.skipped, undefined, 'no delivery-status information of any kind must be returned for a cross-tenant row');
    assert.equal(json.delivery_status, undefined);

    const { data: rowB } = await service.from('sms_queue')
      .select('delivery_status, delivery_checked_at, delivery_failure_reason')
      .eq('id', rowBId).single();
    assert.equal(rowB.delivery_status, null, 'Org B\'s row must be completely unaffected by Org A\'s admin');
    assert.equal(rowB.delivery_checked_at, null);
    assert.equal(rowB.delivery_failure_reason, null);
  });

  test('Test 3 - a non-admin (steward) of Org A is rejected outright, even for their own org\'s row', async () => {
    const token = await tokenFor(stewardA);
    const { status, json } = await callEdgeFunction('check-sms-delivery', { id: rowAId }, token);
    assert.equal(status, 403, JSON.stringify(json));
    assert.match(json.error, /Admin role required/i);
  });

  test('Test 4 - an id that does not exist at all is rejected as not-found, not silently treated as any org\'s', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('check-sms-delivery', { id: 2147483601 }, token);
    assert.equal(status, 404, JSON.stringify(json));
  });

  test('Test 5 - a genuine platform admin (org_default) can still check delivery status on another organisation\'s row (regression guard)', async () => {
    const token = await tokenFor(platformAdmin);
    const { status, json } = await callEdgeFunction('check-sms-delivery', { id: rowBId }, token);

    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.skipped, true, 'platform admin must still reach Org B\'s real row data (a genuine mock- skip result), proving the bypass is intentional and correctly scoped, not accidental');
  });

  test('Test 6 - identifier manipulation is safely rejected', async () => {
    const token = await tokenFor(ownerA);

    const malformed = await callEdgeFunction('check-sms-delivery', { id: 'not-a-number' }, token);
    assert.equal(malformed.status, 400, JSON.stringify(malformed.json));

    const missing = await callEdgeFunction('check-sms-delivery', {}, token);
    assert.equal(missing.status, 400, JSON.stringify(missing.json));

    const wrongType = await callEdgeFunction('check-sms-delivery', { id: [rowAId] }, token);
    assert.equal(wrongType.status, 400, JSON.stringify(wrongType.json));

    const float = await callEdgeFunction('check-sms-delivery', { id: rowAId + 0.5 }, token);
    assert.equal(float.status, 400, JSON.stringify(float.json));
  });
});
