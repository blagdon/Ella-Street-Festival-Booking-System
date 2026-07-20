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
  await service.from('booking_locations').delete().like('booking_id', `${PREFIX}%`);
  await service.from('bookings').delete().like('id', `${PREFIX}%`);
  await service.from('audit_logs').delete().eq('target_id', AUDIT_TARGET);
  await service.from('locations').delete().eq('id', 'TESTLOC-PRIV');
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

describe('bookings.status is constrained (20260720110000)', () => {
  test('rejects a status outside the six real values', async () => {
    const id = `${PREFIX}-0004`;
    const { error } = await service.from('bookings').insert({
      id,
      status: 'Confrimed', // deliberate typo — the exact failure this guards
      business_name: 'Typo Test Co',
      owner_name: 'Test Owner',
      email: 'priv-test@example.test',
      instance_prefix: 'ESF26-DEV-',
      stall_type: 'Food',
    });
    assert.ok(error, 'a typo\'d status must be rejected by the database, not silently stored');
    assert.match(error.message + (error.details || ''), /bookings_status_check|violates check constraint/i);
  });

  // NOTE: this passes because of a PRE-EXISTING NOT NULL on bookings.status,
  // not because of the 20260720110000 migration. That migration's
  // `ALTER COLUMN status SET NOT NULL` turned out to be a no-op - the column
  // was already NOT NULL, which I only established by diffing a production
  // dump taken before the change against one taken after. The migration
  // comment claims otherwise and overstates what it did; the SQL is valid and
  // harmless (SET NOT NULL is idempotent) so the applied migration is left
  // alone rather than edited after the fact. Keeping the test as a regression
  // guard on the real constraint, correctly labelled.
  test('rejects a NULL status (guards the pre-existing NOT NULL)', async () => {
    const id = `${PREFIX}-0005`;
    const { error } = await service.from('bookings').insert({
      id,
      status: null,
      business_name: 'Null Status Co',
      owner_name: 'Test Owner',
      email: 'priv-test@example.test',
      instance_prefix: 'ESF26-DEV-',
      stall_type: 'Food',
    });
    assert.ok(error, 'a NULL status strands a booking the same way a typo does and must be rejected');
  });

  test('accepts every status the app actually uses, including transitions', async () => {
    // Mirrors CONFIG.UI.STATUS_LIST in js/config.js. If this ever fails, the
    // constraint and the app's list have drifted apart — fix both together.
    const statuses = ['Pending', 'Payment Requested', 'Confirmed', 'Rejected', 'Cancelled', 'HCC Checks'];
    const id = `${PREFIX}-0006`;
    await insertBooking(id);

    for (const status of statuses) {
      const { error } = await service.from('bookings').update({ status }).eq('id', id);
      assert.equal(error, null, `status '${status}' must be accepted: ${error?.message}`);
    }
  });

  test('omitting status still defaults to Pending (NOT NULL must not break inserts)', async () => {
    const id = `${PREFIX}-0007`;
    const { error } = await service.from('bookings').insert({
      id,
      business_name: 'Default Status Co',
      owner_name: 'Test Owner',
      email: 'priv-test@example.test',
      instance_prefix: 'ESF26-DEV-',
      stall_type: 'Food',
    });
    assert.equal(error, null, `an insert omitting status must still work: ${error?.message}`);

    const { data } = await service.from('bookings').select('status').eq('id', id).single();
    assert.equal(data.status, 'Pending');
  });
});

describe('anon cannot execute rpc_set_booking_locations (20260720110100)', () => {
  test('a genuinely anon caller is rejected at the grant level', async () => {
    // Fresh client with no session — the file-level `authed` client is signed
    // in as admin, so reusing it here would test the wrong thing entirely.
    const trueAnon = createClient(url, anonKey);
    const { error } = await trueAnon.rpc('rpc_set_booking_locations', {
      p_booking_id: `${PREFIX}-0001`,
      p_location_ids: ['TESTLOC-ANON'],
    });
    assert.ok(error, 'anon must be rejected calling rpc_set_booking_locations');
    assert.match(error.message, /permission denied|not find the function/i,
      `expected a permission error, got: ${error.message}`);
  });

  test('an admin can still call it (regression guard for the revoke)', async () => {
    const id = `${PREFIX}-0008`;
    await insertBooking(id);
    await service.from('bookings').update({ status: 'Confirmed' }).eq('id', id);
    await service.from('locations').upsert({ id: 'TESTLOC-PRIV', dataset: 'LIVE', lat: 0, lng: 0 });

    const { error } = await authed.rpc('rpc_set_booking_locations', {
      p_booking_id: id,
      p_location_ids: ['TESTLOC-PRIV'],
    });
    assert.equal(error, null, `admin must still be able to assign pitches: ${error?.message}`);

    const { data } = await service.from('booking_locations').select('location_id').eq('booking_id', id);
    assert.equal(data.length, 1, 'the assignment should have been written');
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
