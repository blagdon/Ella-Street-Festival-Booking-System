// Regression tests for E5-27: provision-organisation checked admin status
// against ANY organisation's organisation_members row (falling back to the
// legacy global user_roles table), with no platform-admin distinction at
// all - so an admin of any single tenant organisation, however small, could
// provision arbitrary brand-new organisations, choose their booking prefix
// and branding-adjacent settings, and trigger a genuine platform-branded
// Supabase invite email to an owner_email address of their own choosing.
//
// The organisations table's own INSERT RLS policy already required
// is_platform_admin() alone (20260805000000_membership_scope_org_
// visibility.sql) - this service-role Edge Function bypasses that RLS
// policy entirely, so it silently allowed something the database itself
// would have refused for a direct authenticated insert.
//
// Fixed in supabase/functions/provision-organisation/index.ts by replacing
// the organisation_members/user_roles check with resolveCallerAdminScope(),
// gated strictly on callerScope.isPlatformAdmin - deliberately no
// orgIds.length fallback, since provisioning creates a new organisation
// rather than acting on an existing one there is no org to scope against.
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
const ORG_SEED = `e527-seed-${RUN_ID}`;
const TENANT_ADMIN_EMAIL = `e527-tenant-admin-${RUN_ID}@example.test`;
const TENANT_ADMIN_PASSWORD = genTestPassword();
const STEWARD_EMAIL = `e527-steward-${RUN_ID}@example.test`;
const STEWARD_PASSWORD = genTestPassword();

// Three distinct target slugs - one per test that actually calls
// provision-organisation - so a bug that fails to reject one attempt can't
// be masked by a slug collision with another test's own target.
const NEW_ORG_SLUG_TENANT = `e527-new-tenant-${RUN_ID}`;
const NEW_ORG_SLUG_STEWARD = `e527-new-steward-${RUN_ID}`;
const NEW_ORG_SLUG_PLATFORM = `e527-new-platform-${RUN_ID}`;
const NEW_OWNER_EMAIL_TENANT = `e527-newowner-tenant-${RUN_ID}@example.test`;
const NEW_OWNER_EMAIL_STEWARD = `e527-newowner-steward-${RUN_ID}@example.test`;
const NEW_OWNER_EMAIL_PLATFORM = `e527-newowner-platform-${RUN_ID}@example.test`;

let tenantAdminId, stewardId;
let tenantAdmin, steward, platformAdmin;

async function tokenFor(client) {
  const { data } = await client.auth.getSession();
  return data.session.access_token;
}

// FK-safe order, matching provision-organisation's own rollback catch block
// and phase3-provisioning.test.mjs / e2e/provisioning.spec.mjs's cleanup.
async function cleanupProvisionedOrg(orgSlug, ownerEmail) {
  await service.from('events').delete().eq('org_id', orgSlug);
  await service.from('settings').delete().eq('org_id', orgSlug);
  await service.from('email_templates').delete().eq('org_id', orgSlug);
  await service.from('sms_templates').delete().eq('org_id', orgSlug);
  await service.from('organisation_members').delete().eq('org_id', orgSlug);
  await service.from('organisations').delete().eq('id', orgSlug);

  // A successful provisioning run always upserts a user_roles row for the
  // owner (via a real invite, or the placeholder fallback with a fresh
  // random id) - looking it up by email finds either shape without needing
  // the response to carry an owner_user_id field, which it doesn't.
  const { data: roleRow } = await service.from('user_roles').select('id').eq('email', ownerEmail).maybeSingle();
  if (roleRow?.id) {
    await service.from('user_roles').delete().eq('id', roleRow.id);
    await service.auth.admin.deleteUser(roleRow.id).catch(() => {});
  }
}

before(async () => {
  const { error: orgErr } = await service.from('organisations')
    .insert({ id: ORG_SEED, name: `E5-27 Test ${ORG_SEED}`, slug: ORG_SEED, contact_email: 'owner@example.test' });
  assert.equal(orgErr, null, orgErr?.message);

  const { data: tenantAdminCreated, error: tenantAdminErr } = await service.auth.admin.createUser({
    email: TENANT_ADMIN_EMAIL, password: TENANT_ADMIN_PASSWORD, email_confirm: true,
  });
  assert.equal(tenantAdminErr, null, tenantAdminErr?.message);
  tenantAdminId = tenantAdminCreated.user.id;
  // A real admin of ORG_SEED only - never org_default. This is exactly the
  // shape the OLD (pre-fix) code accepted: an organisation_members admin
  // row for ANY organisation, with no org_id correlation at all. Also given
  // a user_roles row, matching what rpc_add_organisation_member() writes
  // for every real admin invited through the normal flow - without it, the
  // OLD code's second (legacy user_roles) fallback path would go untested,
  // and this fixture wouldn't reproduce the full vulnerable surface.
  const { error: memberErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_SEED, user_id: tenantAdminId, role: 'admin' });
  assert.equal(memberErr, null, memberErr?.message);
  const { error: legacyRoleErr } = await service.from('user_roles')
    .insert({ id: tenantAdminId, email: TENANT_ADMIN_EMAIL, role: 'admin' });
  assert.equal(legacyRoleErr, null, legacyRoleErr?.message);

  tenantAdmin = createClient(url, anonKey);
  const { error: tenantSignInErr } = await tenantAdmin.auth.signInWithPassword({ email: TENANT_ADMIN_EMAIL, password: TENANT_ADMIN_PASSWORD });
  assert.equal(tenantSignInErr, null, tenantSignInErr?.message);

  const { data: stewardCreated, error: stewardErr } = await service.auth.admin.createUser({
    email: STEWARD_EMAIL, password: STEWARD_PASSWORD, email_confirm: true,
  });
  assert.equal(stewardErr, null, stewardErr?.message);
  stewardId = stewardCreated.user.id;
  const { error: stewardMemberErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_SEED, user_id: stewardId, role: 'steward' });
  assert.equal(stewardMemberErr, null, stewardMemberErr?.message);

  steward = createClient(url, anonKey);
  const { error: stewardSignInErr } = await steward.auth.signInWithPassword({ email: STEWARD_EMAIL, password: STEWARD_PASSWORD });
  assert.equal(stewardSignInErr, null, stewardSignInErr?.message);

  platformAdmin = createClient(url, anonKey);
  const { error: platformSignInErr } = await platformAdmin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  assert.equal(platformSignInErr, null, platformSignInErr?.message);
});

after(async () => {
  // Best-effort: none of these should exist if the rejections worked, but
  // cleaning up defensively means a real regression doesn't also leak test
  // fixtures into the shared test project.
  await cleanupProvisionedOrg(NEW_ORG_SLUG_TENANT, NEW_OWNER_EMAIL_TENANT);
  await cleanupProvisionedOrg(NEW_ORG_SLUG_STEWARD, NEW_OWNER_EMAIL_STEWARD);
  await cleanupProvisionedOrg(NEW_ORG_SLUG_PLATFORM, NEW_OWNER_EMAIL_PLATFORM);

  await service.from('organisation_members').delete().eq('org_id', ORG_SEED);
  await service.from('organisations').delete().eq('id', ORG_SEED);
  if (tenantAdminId) { await service.from('user_roles').delete().eq('id', tenantAdminId); await service.auth.admin.deleteUser(tenantAdminId); }
  if (stewardId) await service.auth.admin.deleteUser(stewardId);
});

describe('E5-27: provision-organisation platform-admin authorization', () => {
  test('Test 1 (critical regression test) - an admin of an ordinary tenant organisation CANNOT provision a new organisation', async () => {
    const token = await tokenFor(tenantAdmin);
    const { status, json } = await callEdgeFunction('provision-organisation', {
      org_name: 'E5-27 Tenant-Attempted Org',
      org_slug: NEW_ORG_SLUG_TENANT,
      owner_email: NEW_OWNER_EMAIL_TENANT,
      event_name: 'E5-27 Tenant-Attempted Event',
      event_prefix: `E527T${RUN_ID.toString().slice(-4)}`,
      dry_run: false,
    }, token);

    // Rejected before any provisioning side effect runs: the OLD code
    // accepted exactly this fixture (a real organisation_members admin of
    // ANY org), so a non-403 result here would mean the fix regressed.
    assert.equal(status, 403, `tenant admin must be rejected, got ${status}: ${JSON.stringify(json)}`);
    assert.match(json.error, /platform admin/i);

    // No organisation was created for the requested slug.
    const { data: orgRow } = await service.from('organisations').select('id').eq('id', NEW_ORG_SLUG_TENANT).maybeSingle();
    assert.equal(orgRow, null, 'no organisation should exist for a rejected provisioning request');

    // No owner side effect of any kind - provisioning always upserts
    // user_roles for the owner as part of a successful run, so a missing
    // row here proves the whole pipeline never started, not just that the
    // final response happened to be an error.
    const { data: roleRow } = await service.from('user_roles').select('id').eq('email', NEW_OWNER_EMAIL_TENANT).maybeSingle();
    assert.equal(roleRow, null, 'no owner account/invitation side effect should exist for a rejected provisioning request');

    // No event was created either.
    const { data: eventRows } = await service.from('events').select('id').eq('org_id', NEW_ORG_SLUG_TENANT);
    assert.equal(eventRows.length, 0, 'no event should exist for a rejected provisioning request');
  });

  test('Test 2 - a steward (non-admin) is rejected outright', async () => {
    const token = await tokenFor(steward);
    const { status, json } = await callEdgeFunction('provision-organisation', {
      org_name: 'E5-27 Steward-Attempted Org',
      org_slug: NEW_ORG_SLUG_STEWARD,
      owner_email: NEW_OWNER_EMAIL_STEWARD,
      event_name: 'E5-27 Steward-Attempted Event',
      event_prefix: `E527S${RUN_ID.toString().slice(-4)}`,
      dry_run: false,
    }, token);

    assert.equal(status, 403, JSON.stringify(json));
    assert.match(json.error, /platform admin/i);

    const { data: orgRow } = await service.from('organisations').select('id').eq('id', NEW_ORG_SLUG_STEWARD).maybeSingle();
    assert.equal(orgRow, null, 'no organisation should exist for a rejected provisioning request');
  });

  test('Test 3 - an unauthenticated caller is rejected', async () => {
    const { status, json } = await callEdgeFunction('provision-organisation', {
      org_name: 'E5-27 Unauthenticated-Attempted Org',
      org_slug: `e527-unauth-${RUN_ID}`,
      owner_email: `e527-unauth-owner-${RUN_ID}@example.test`,
      event_name: 'E5-27 Unauthenticated-Attempted Event',
      event_prefix: `E527U${RUN_ID.toString().slice(-4)}`,
      dry_run: false,
    }, anonKey);

    assert.equal(status, 401, JSON.stringify(json));
  });

  test('Test 4 - a genuine platform admin (org_default) can still provision a real organisation (regression guard)', async () => {
    const token = await tokenFor(platformAdmin);
    const { status, json } = await callEdgeFunction('provision-organisation', {
      org_name: 'E5-27 Platform-Admin Org',
      org_slug: NEW_ORG_SLUG_PLATFORM,
      owner_email: NEW_OWNER_EMAIL_PLATFORM,
      event_name: 'E5-27 Platform-Admin Event',
      event_prefix: `E527P${RUN_ID.toString().slice(-4)}`,
      dry_run: false,
    }, token);

    assert.equal(status, 200, `platform admin must still be able to provision, got ${status}: ${JSON.stringify(json)}`);
    assert.equal(json.status, 'success');
    assert.equal(json.org_id, NEW_ORG_SLUG_PLATFORM);
    assert.equal(json.event_status, 'draft');
    assert.ok(json.settings_initialised > 0, 'platform defaults settings should be cloned');
    assert.ok(json.email_templates_initialised > 0, 'platform defaults email templates should be cloned');

    const { data: orgRow } = await service.from('organisations').select('id, name').eq('id', NEW_ORG_SLUG_PLATFORM).single();
    assert.equal(orgRow.name, 'E5-27 Platform-Admin Org');

    const { data: memberRow } = await service.from('organisation_members')
      .select('role').eq('org_id', NEW_ORG_SLUG_PLATFORM).eq('role', 'admin').maybeSingle();
    assert.ok(memberRow, 'the requested owner should be a real admin member of the new organisation');

    // Cleanup happens in after(), same as the other two target slugs, so a
    // failure partway through this test still leaves the shared test
    // project clean.
  });
});
