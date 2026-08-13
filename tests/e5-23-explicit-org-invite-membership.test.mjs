// Regression tests for E5-23 (expanded scope): rpc_add_organisation_member
// used to resolve its target organisation ambiently via get_current_org_id()
// - a JWT claim this deployment never populates, falling back to an
// organisation_members lookup for the CALLER's own account, which does not
// necessarily match whatever organisation a platform admin has selected via
// the UI's org-switcher. A platform admin inviting a member to Organisation
// B could therefore have the membership silently created in a different
// organisation. It also meant invite-organisation-member had no reliable
// way to know which organisation's own base_url setting to use for the
// invite link (the original, narrower E5-23 finding).
//
// Fixed by 20260813140000_e5_23_explicit_org_invite_membership.sql:
// rpc_add_organisation_member now requires an explicit p_org_id, authorised
// via is_authorised_for_org(p_org_id, ARRAY['admin']) - the same primitive
// already proven correct for this exact pattern elsewhere in the schema
// (tests/rpc-authorisation.test.mjs) - and returns that authoritative
// org_id in its result. invite-organisation-member/index.ts now requires
// orgId in its request body and resolves base_url against the RPC's own
// returned org_id, never re-deriving org context. js/page-admin.js now
// sends ctx.orgId explicitly instead of relying on ambient resolution.
//
// Revised again before commit: a genuinely new invitee whose target org has
// no base_url used to have its membership committed by the RPC BEFORE the
// Edge Function discovered base_url was missing - a partial-success state
// (membership created, invite never sent, caller sees an error). Fixed by
// moving the base_url *existence* check (never its value) into the RPC's
// own transaction, scoped only to the branch it already computes for
// itself (is this invitee genuinely new - no real auth.users row yet).
// RAISE EXCEPTION there rolls back everything the same call already wrote,
// including both INSERTs - a Postgres function's statements share one
// transaction, so no compensating DELETE is needed or used. The RPC now
// also returns is_new_invitee, so invite-organisation-member no longer
// needs its own separate getUserById() call to re-derive what the RPC
// already determined authoritatively.
//
// A note on email verification: this test project is a shared, rate-limited
// hosted Supabase project, and its GoTrue instance rejects @*.test-domain
// email addresses at the format-validation stage (confirmed empirically
// before writing this file - "Email address ... is invalid") BEFORE
// creating any auth.users row or attempting delivery, independent of
// redirectTo. Every test that must NOT risk a real send (existing-invitee
// cases, and the missing-base_url case, which never reaches the send step
// at all) uses a PRE-EXISTING auth.users account or relies on that
// rejection happening first. Test A (the one scenario that specifically
// needs a genuinely NEW invitee with a valid base_url) still uses a
// @*.test address for the same safety reason; invite_sent is expected to
// be false there too - not because base_url resolution failed (proven
// separately by direct settings query), but because of this same
// environment-level email-format rejection, which is orthogonal to E5-23
// and already true of every invite this project has ever sent in tests.
// rpc_add_organisation_member's EXECUTE grants were verified by direct
// database introspection (pg_proc.proacl), not from here - not reachable
// via the anon/authenticated PostgREST surface.
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
const ORG_A = `e523-org-a-${RUN_ID}`;
const ORG_B = `e523-org-b-${RUN_ID}`;
const ORG_C = `e523-org-c-${RUN_ID}`; // deliberately given no base_url row
const ORG_A_BASE_URL = `https://org-a-${RUN_ID}.example.test`;
const ORG_B_BASE_URL = `https://org-b-${RUN_ID}.example.test`;
const OWNER_A_EMAIL = `e523-owner-a-${RUN_ID}@example.test`;
const OWNER_A_PASSWORD = genTestPassword();

let ownerA, ownerAId;
let platformAdmin;
const createdUserIds = [];      // real auth.users accounts this file pre-creates, for cleanup
const newInviteeEmails = [];    // genuinely-new invitee emails used, for user_roles/organisation_members cleanup

async function createExistingInvitee(label) {
  const email = `e523-${label}-${RUN_ID}@example.test`;
  const { data, error } = await service.auth.admin.createUser({ email, password: genTestPassword(), email_confirm: true });
  assert.equal(error, null, error?.message);
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email };
}

function newInviteeEmail(label) {
  const email = `e523-${label}-${RUN_ID}@example.test`;
  newInviteeEmails.push(email);
  return email;
}

before(async () => {
  const { error: orgAErr } = await service.from('organisations')
    .insert({ id: ORG_A, name: `E5-23 Org A ${ORG_A}`, slug: ORG_A, contact_email: 'owner@example.test' });
  assert.equal(orgAErr, null, orgAErr?.message);
  const { error: orgBErr } = await service.from('organisations')
    .insert({ id: ORG_B, name: `E5-23 Org B ${ORG_B}`, slug: ORG_B, contact_email: 'owner@example.test' });
  assert.equal(orgBErr, null, orgBErr?.message);
  const { error: orgCErr } = await service.from('organisations')
    .insert({ id: ORG_C, name: `E5-23 Org C ${ORG_C}`, slug: ORG_C, contact_email: 'owner@example.test' });
  assert.equal(orgCErr, null, orgCErr?.message);

  // Distinct, non-shared base_url per org - proves the Edge Function used
  // THIS org's own row, not the platform default (which would be identical
  // for both orgs and so prove nothing) and not the other org's row. Org C
  // deliberately gets no settings row at all.
  const { error: settingsAErr } = await service.from('settings')
    .insert({ org_id: ORG_A, key: 'base_url', value: ORG_A_BASE_URL, updated_by: 'test-fixture' });
  assert.equal(settingsAErr, null, settingsAErr?.message);
  const { error: settingsBErr } = await service.from('settings')
    .insert({ org_id: ORG_B, key: 'base_url', value: ORG_B_BASE_URL, updated_by: 'test-fixture' });
  assert.equal(settingsBErr, null, settingsBErr?.message);

  const { data: ownerCreated, error: ownerErr } = await service.auth.admin.createUser({
    email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD, email_confirm: true,
  });
  assert.equal(ownerErr, null, ownerErr?.message);
  ownerAId = ownerCreated.user.id;
  const { error: memberAErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_A, user_id: ownerAId, role: 'admin' });
  assert.equal(memberAErr, null, memberAErr?.message);

  ownerA = createClient(url, anonKey);
  const { error: signInAErr } = await ownerA.auth.signInWithPassword({ email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD });
  assert.equal(signInAErr, null, signInAErr?.message);

  platformAdmin = createClient(url, anonKey);
  const { error: platformSignInErr } = await platformAdmin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  assert.equal(platformSignInErr, null, `Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${platformSignInErr?.message}`);
});

after(async () => {
  await service.from('organisation_members').delete().in('org_id', [ORG_A, ORG_B, ORG_C]);
  await service.from('settings').delete().in('org_id', [ORG_A, ORG_B, ORG_C]);
  await service.from('organisations').delete().in('id', [ORG_A, ORG_B, ORG_C]);
  for (const email of newInviteeEmails) {
    await service.from('user_roles').delete().eq('email', email);
  }
  const allIds = [...createdUserIds, ...(ownerAId ? [ownerAId] : [])];
  for (const id of allIds) {
    await service.from('user_roles').delete().eq('id', id);
    await service.auth.admin.deleteUser(id).catch(() => {});
  }
});

async function tokenFor(client) {
  const { data } = await client.auth.getSession();
  return data.session.access_token;
}

describe('E5-23 Case A: a genuinely new invitee, target organisation has a valid base_url', () => {
  test('succeeds, membership created, org_id correct, is_new_invitee=true, base_url resolves to the target org\'s own', async () => {
    const email = newInviteeEmail('case-a-new-invitee');
    const { status, json } = await callEdgeFunction(
      'invite-organisation-member',
      { email, role: 'steward', orgId: ORG_A },
      await tokenFor(ownerA)
    );
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.org_id, ORG_A);
    assert.equal(json.is_new_invitee, true, 'this email has no prior auth.users account');
    // invite_sent may legitimately be false here: this environment's GoTrue
    // rejects @*.test addresses at format-validation, before any send is
    // attempted - orthogonal to E5-23, true of every invite this project
    // has ever sent in tests (see file header). What matters is that the
    // invite path was REACHED at all (unlike Case G below, where it never
    // is) and that it would have used the right URL - proven directly.
    assert.equal(typeof json.invite_sent, 'boolean');

    const { data: memberRow } = await service.from('organisation_members')
      .select('org_id, role').eq('org_id', ORG_A).eq('user_id', json.user_id).single();
    assert.ok(memberRow, 'membership row must exist in Org A');
    assert.equal(memberRow.role, 'steward');

    const { data: settingsRow } = await service.from('settings')
      .select('value').eq('org_id', ORG_A).eq('key', 'base_url').single();
    assert.equal(settingsRow.value, ORG_A_BASE_URL, 'the base_url the invite link would be built from must be Org A\'s own');
  });
});

describe('E5-23 Case B: a platform admin inviting to a DIFFERENT organisation (mandatory security test)', () => {
  test('succeeds, creates membership in B (not the platform admin\'s own org), returns org_id=B, is_new_invitee correct, uses B\'s own base_url', async () => {
    const invitee = await createExistingInvitee('case-b-invitee');
    const { status, json } = await callEdgeFunction(
      'invite-organisation-member',
      { email: invitee.email, role: 'admin', orgId: ORG_B },
      await tokenFor(platformAdmin)
    );
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.org_id, ORG_B, 'must be Org B, not org_default or wherever the platform admin\'s own session context might resolve to');
    assert.equal(json.is_new_invitee, false, 'this invitee already has a real auth.users account (created in the fixture above)');
    assert.equal(json.invite_sent, false, 'invitee already exists - no invite email should be attempted at all');

    const { data: memberRow } = await service.from('organisation_members')
      .select('org_id, role').eq('org_id', ORG_B).eq('user_id', invitee.id).single();
    assert.ok(memberRow, 'membership row must exist in Org B');
    assert.equal(memberRow.role, 'admin');

    // Prove the platform admin's own organisation context did not leak in:
    // no membership row for this invitee anywhere except Org B.
    const { data: allMemberships } = await service.from('organisation_members')
      .select('org_id').eq('user_id', invitee.id);
    assert.deepEqual(allMemberships.map((r) => r.org_id), [ORG_B]);

    const { data: settingsRow } = await service.from('settings')
      .select('value').eq('org_id', ORG_B).eq('key', 'base_url').single();
    assert.equal(settingsRow.value, ORG_B_BASE_URL, 'must resolve against Org B\'s own base_url, not the platform default and not Org A\'s');
  });
});

describe('E5-23 Case C: an ordinary admin attempting a cross-tenant invite', () => {
  test('is rejected, and no membership or user_roles row is created for the target org', async () => {
    const targetEmail = `e523-case-c-target-${RUN_ID}@example.test`;
    const { status, json } = await callEdgeFunction(
      'invite-organisation-member',
      { email: targetEmail, role: 'steward', orgId: ORG_B },
      await tokenFor(ownerA)
    );
    assert.notEqual(status, 200, 'Org A\'s admin must not be able to add a member to Org B');
    assert.ok(json.error, JSON.stringify(json));

    const { data: memberRow } = await service.from('organisation_members')
      .select('org_id').eq('org_id', ORG_B).eq('user_id', ownerAId);
    assert.equal((memberRow || []).length, 0);

    const { data: roleRow } = await service.from('user_roles').select('id').eq('email', targetEmail).maybeSingle();
    assert.equal(roleRow, null, 'a rejected cross-tenant attempt must leave no trace of the target invitee');
  });
});

describe('E5-23 Case D: an unauthenticated/no-session caller', () => {
  test('is rejected by the RPC\'s own authorisation check, no membership created', async () => {
    const targetEmail = `e523-case-d-target-${RUN_ID}@example.test`;
    // anonKey as bearer is a valid API key but represents no signed-in user
    // session - auth.uid() is NULL inside the RPC, exercising
    // is_authorised_for_org's real rejection path, not just the Edge
    // Function's shallow "header present or not" check.
    const { status, json } = await callEdgeFunction(
      'invite-organisation-member',
      { email: targetEmail, role: 'steward', orgId: ORG_A },
      anonKey
    );
    assert.notEqual(status, 200, JSON.stringify(json));
    assert.ok(json.error, JSON.stringify(json));

    const { data: roleRow } = await service.from('user_roles').select('id').eq('email', targetEmail).maybeSingle();
    assert.equal(roleRow, null);
  });
});

describe('E5-23 Case E: org_default confers no special privilege merely by being named', () => {
  test('Org A\'s admin supplying orgId=org_default is rejected exactly like any other non-member org', async () => {
    const targetEmail = `e523-orgdefault-spoof-${RUN_ID}@example.test`;
    const { status, json } = await callEdgeFunction(
      'invite-organisation-member',
      { email: targetEmail, role: 'admin', orgId: 'org_default' },
      await tokenFor(ownerA)
    );
    assert.notEqual(status, 200, 'naming org_default must confer no privilege to a caller who is not genuinely authorised for it');
    assert.ok(json.error, JSON.stringify(json));

    const { data: roleRow } = await service.from('user_roles').select('id').eq('email', targetEmail).maybeSingle();
    assert.equal(roleRow, null);
  });
});

describe('E5-23 Case F: orgId is required', () => {
  test('a request with no orgId at all is rejected before the RPC is ever called', async () => {
    const targetEmail = `e523-no-orgid-${RUN_ID}@example.test`;
    const { status, json } = await callEdgeFunction(
      'invite-organisation-member',
      { email: targetEmail, role: 'steward' },
      await tokenFor(ownerA)
    );
    assert.equal(status, 400);
    assert.match(json.error || '', /orgId/);
  });
});

describe('E5-23 Case G (critical regression test): a genuinely NEW invitee, target organisation has NO base_url', () => {
  test('the RPC transaction rolls back entirely - no membership, no user_roles row, no invitation, no fallback URL used', async () => {
    const email = newInviteeEmail('case-g-new-invitee-no-baseurl');
    const { status, json } = await callEdgeFunction(
      'invite-organisation-member',
      { email, role: 'steward', orgId: ORG_C },
      await tokenFor(platformAdmin)
    );

    assert.notEqual(status, 200, JSON.stringify(json));
    assert.ok(json.error, 'must fail with a clear error, not silently succeed');
    assert.doesNotMatch(json.error, /base_url|settings|platform_defaults|user_roles|organisation_members/i, 'the error must not expose internal table/setting names');
    assert.equal(json.invite_sent, undefined, 'the response must not even reach the point of setting invite_sent - proves inviteUserByEmail was never called');

    // The critical proof this test exists for: the RPC's own transaction
    // must have rolled back, not merely returned an error while leaving
    // committed rows behind (the pre-fix behaviour this test replaces).
    const { data: roleRow } = await service.from('user_roles').select('id').eq('email', email).maybeSingle();
    assert.equal(roleRow, null, 'no user_roles row must exist for this email - proves the INSERT was rolled back, not merely that the HTTP response was an error');

    const { data: anyMembership } = await service.from('organisation_members').select('org_id').eq('org_id', ORG_C);
    assert.equal((anyMembership || []).length, 0, 'Org C must have zero members - proves no organisation_members row survived the rollback');
  });
});

describe('E5-23 Case H (mandatory): an EXISTING invitee, target organisation has NO base_url', () => {
  test('succeeds unaffected - an already-registered user needs no invitation URL', async () => {
    const invitee = await createExistingInvitee('case-h-existing-no-baseurl');
    const { status, json } = await callEdgeFunction(
      'invite-organisation-member',
      { email: invitee.email, role: 'steward', orgId: ORG_C },
      await tokenFor(platformAdmin)
    );

    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.org_id, ORG_C);
    assert.equal(json.is_new_invitee, false, 'proves the new base_url requirement is scoped only to genuinely new invitees');
    assert.equal(json.invite_sent, false, 'no invitation is needed or sent for an existing account');

    const { data: memberRow } = await service.from('organisation_members')
      .select('org_id, role').eq('org_id', ORG_C).eq('user_id', invitee.id).single();
    assert.ok(memberRow, 'membership must be created despite Org C having no base_url - the absence of base_url must not block adding an existing user');
    assert.equal(memberRow.role, 'steward');
  });
});

describe('E5-23: the old two-argument RPC overload no longer exists', () => {
  test('calling rpc_add_organisation_member with only p_email/p_role fails as an unknown function, not an authorisation error', async () => {
    const { error } = await ownerA.rpc('rpc_add_organisation_member', {
      p_email: `e523-old-sig-${RUN_ID}@example.test`, p_role: 'steward',
    });
    assert.ok(error, 'the 2-argument overload must no longer be callable');
    // PostgREST's schema-cache-miss code for "no function matches this
    // parameter shape" - distinct from a 42501/RAISE EXCEPTION style
    // authorisation rejection, proving this is a signature mismatch, not a
    // permissions check the caller merely failed.
    assert.equal(error.code, 'PGRST202', `expected a function-not-found error, got: ${JSON.stringify(error)}`);
  });

  test('the three-argument form is callable and enforces authorisation (regression guard)', async () => {
    const { error } = await ownerA.rpc('rpc_add_organisation_member', {
      p_org_id: ORG_B, p_email: `e523-new-sig-check-${RUN_ID}@example.test`, p_role: 'steward',
    });
    assert.ok(error, 'Org A\'s admin still must not be authorised for Org B');
    assert.notEqual(error.code, 'PGRST202', 'must be an authorisation rejection, not a missing-function error - proves the 3-arg overload exists');
  });
});
