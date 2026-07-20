// Behavioural tests for the 2026-07-20 privilege hardening:
//   - stewards can no longer UPDATE bookings directly (policy dropped)
//   - audit_logs.user_email is stamped from the JWT, not trusted from the client
//
// Both are checked against the real REST API as a genuinely authenticated
// session, not by reading policy SQL - the repo's standing lesson is that a
// grant/policy statement is not evidence of live behaviour.
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

const authed = createClient(url, anonKey);
const service = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

const PREFIX = 'ESF26-DEV-PRIV';
const AUDIT_TARGET = 'PRIVHARDENING-TARGET';
let adminUserId;

before(async () => {
  const { data, error } = await authed.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${error.message}`);
  adminUserId = data.user.id;

  await service.from('bookings').delete().like('id', `${PREFIX}%`);
  await service.from('audit_logs').delete().eq('target_id', AUDIT_TARGET);
});

after(async () => {
  await service.from('bookings').delete().like('id', `${PREFIX}%`);
  await service.from('audit_logs').delete().eq('target_id', AUDIT_TARGET);
  // Defensive: the demotion test restores this itself, but guarantee it here
  // too so a mid-test failure can never leak a demoted admin into another file.
  await service.from('user_roles').update({ role: 'admin' }).eq('id', adminUserId);
});

async function insertBooking(id) {
  const { error } = await service.from('bookings').insert({
    id,
    status: 'Pending',
    business_name: 'Privilege Test Co',
    owner_name: 'Test Owner',
    email: 'priv-test@example.test',
    instance_prefix: 'ESF26-DEV-',
    stall_type: 'Food',
    stall_cost: 100,
  });
  assert.equal(error, null, error?.message);
}

describe('steward cannot UPDATE bookings directly (20260720100000)', () => {
  test('a steward-role session cannot change stall_cost, status or cancel_token', async () => {
    const id = `${PREFIX}-0001`;
    await insertBooking(id);

    // Capture the real pre-update state rather than assuming it. cancel_token
    // is auto-generated on insert by a column default, so asserting it is
    // null would fail for reasons that have nothing to do with the policy.
    const { data: before } = await service
      .from('bookings')
      .select('stall_cost, status, cancel_token')
      .eq('id', id)
      .single();

    // Same approach the bank-transfer suite uses: temporarily demote the test
    // admin, since no dedicated steward user exists in the fixtures.
    const { error: demoteErr } = await service.from('user_roles').update({ role: 'steward' }).eq('id', adminUserId);
    assert.equal(demoteErr, null, demoteErr?.message);

    try {
      // With the policy dropped, an UPDATE matching no policy is not an error -
      // PostgREST reports success having affected zero rows. So the row's
      // actual stored state is the only trustworthy assertion here.
      await authed.from('bookings')
        .update({ stall_cost: 99999, status: 'Confirmed', cancel_token: 'stolen-token' })
        .eq('id', id);

      const { data: after } = await service
        .from('bookings')
        .select('stall_cost, status, cancel_token')
        .eq('id', id)
        .single();

      assert.equal(Number(after.stall_cost), Number(before.stall_cost), 'a steward must not be able to change stall_cost');
      assert.equal(after.status, before.status, 'a steward must not be able to change status');
      assert.equal(after.cancel_token, before.cancel_token,
        'a steward must not be able to overwrite cancel_token (that token is the public self-service cancellation key)');
    } finally {
      await service.from('user_roles').update({ role: 'admin' }).eq('id', adminUserId);
    }
  });

  test('a steward can still READ bookings (the "Steward access" policy is retained)', async () => {
    const id = `${PREFIX}-0002`;
    await insertBooking(id);

    const { error: demoteErr } = await service.from('user_roles').update({ role: 'steward' }).eq('id', adminUserId);
    assert.equal(demoteErr, null, demoteErr?.message);

    try {
      const { data, error } = await authed.from('bookings').select('id').eq('id', id);
      assert.equal(error, null, `steward SELECT on bookings must keep working: ${error?.message}`);
      assert.equal(data.length, 1, 'steward should still see the booking - steward.html lists bookings');
    } finally {
      await service.from('user_roles').update({ role: 'admin' }).eq('id', adminUserId);
    }
  });

  test('an admin can still UPDATE bookings (regression guard for the dropped policy)', async () => {
    const id = `${PREFIX}-0003`;
    await insertBooking(id);

    const { error } = await authed.from('bookings').update({ stall_cost: 250 }).eq('id', id);
    assert.equal(error, null, error?.message);

    const { data: after } = await service.from('bookings').select('stall_cost').eq('id', id).single();
    assert.equal(Number(after.stall_cost), 250, 'admin updates must be unaffected by dropping the steward policy');
  });
});

describe('audit_logs.user_email is server-stamped (20260720100100)', () => {
  test('a forged user_email is overwritten with the JWT identity', async () => {
    const { error } = await authed.from('audit_logs').insert({
      action: 'privilege_hardening_test',
      target_id: AUDIT_TARGET,
      user_email: 'someone-else@evil.test',
      details: JSON.stringify({ forged: true }),
      instance: 'DEV',
    });
    assert.equal(error, null, error?.message);

    const { data } = await service
      .from('audit_logs')
      .select('user_email')
      .eq('target_id', AUDIT_TARGET)
      .order('id', { ascending: false })
      .limit(1)
      .single();

    assert.equal(data.user_email, adminEmail,
      'the trigger must replace a client-supplied user_email with the JWT email');
    assert.notEqual(data.user_email, 'someone-else@evil.test');
  });

  test('a service_role insert keeps its supplied user_email (the Edge Function path)', async () => {
    // service_role's JWT carries no email claim. Overwriting unconditionally
    // would blank these rows, so the trigger must leave them alone - this is
    // the case that would break server-side audit logging if the fallback
    // were ever removed.
    const { error } = await service.from('audit_logs').insert({
      action: 'privilege_hardening_test',
      target_id: AUDIT_TARGET,
      user_email: 'system_edge_function',
      details: JSON.stringify({ serverSide: true }),
      instance: 'DEV',
    });
    assert.equal(error, null, error?.message);

    const { data } = await service
      .from('audit_logs')
      .select('user_email')
      .eq('target_id', AUDIT_TARGET)
      .eq('action', 'privilege_hardening_test')
      .order('id', { ascending: false })
      .limit(1)
      .single();

    assert.equal(data.user_email, 'system_edge_function',
      'service_role inserts must keep their supplied identity - they have no email claim to stamp from');
  });

  test('audit logging still works when no user_email is supplied at all', async () => {
    // Guards the "trigger must never block a write" property: a malformed or
    // absent identity should still produce a row.
    const { error } = await authed.from('audit_logs').insert({
      action: 'privilege_hardening_test',
      target_id: AUDIT_TARGET,
      details: JSON.stringify({ noEmail: true }),
      instance: 'DEV',
    });
    assert.equal(error, null, `audit insert must not fail without user_email: ${error?.message}`);
  });
});
