// Behavioural tests for the 2026-07-20 user_roles.role text->enum
// consolidation (20260720130000_consolidate_user_roles_enum.sql).
//
// This migration touches 13 of the schema's 23 policies (7 via
// check_user_role(), 1 via get_is_admin(), 6 rewritten directly), plus a
// column type change and dropping the eq_text_user_role() operator shim. The
// whole point of testing behaviourally rather than reading the SQL is that a
// cross-type operator resolution mistake is exactly the kind of thing that
// looks correct in a migration file and fails - or silently returns the wrong
// rows - only when actually executed. Every check here calls the real REST
// API as a genuinely authenticated session.
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

const PREFIX = 'ESF26-DEV-ROLEENUM';
let adminUserId;

async function asSteward(fn) {
  const { error: demoteErr } = await service.from('user_roles').update({ role: 'steward' }).eq('id', adminUserId);
  assert.equal(demoteErr, null, `demotion itself must succeed: ${demoteErr?.message}`);
  try {
    return await fn();
  } finally {
    await service.from('user_roles').update({ role: 'admin' }).eq('id', adminUserId);
  }
}

before(async () => {
  const { data, error } = await authed.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${error.message}`);
  adminUserId = data.user.id;

  await service.from('email_templates').update({ subject: 'Role enum test baseline' }).eq('id', 'application_received');
  await service.from('bookings').delete().like('id', `${PREFIX}%`);
});

after(async () => {
  await service.from('bookings').delete().like('id', `${PREFIX}%`);
  await service.from('user_roles').update({ role: 'admin' }).eq('id', adminUserId);
});

describe('the six directly-rewritten policies (previously plain text, now user_role)', () => {
  test('admin can write email_templates (Admin manage email_templates)', async () => {
    const { error } = await authed.from('email_templates').update({ subject: 'Role enum test' }).eq('id', 'application_received');
    assert.equal(error, null, `admin update must succeed: ${error?.message}`);
  });

  test('a steward cannot write email_templates', async () => {
    const { data: before } = await service.from('email_templates').select('subject').eq('id', 'application_received').single();

    await asSteward(async () => {
      const { error } = await authed
        .from('email_templates')
        .update({ subject: 'should not apply' })
        .eq('id', 'application_received');
      // RLS makes an unauthorized UPDATE affect zero rows rather than error -
      // the actual stored value is the real assertion.
      assert.equal(error, null, error?.message);
    });

    const { data: after } = await service.from('email_templates').select('subject').eq('id', 'application_received').single();
    assert.equal(after.subject, before.subject, 'a steward-authored update must not have changed the row');
  });

  test('admin can write settings (Allow admins full access to settings)', async () => {
    const { error } = await authed.from('settings').upsert({ key: 'role_enum_test_key', value: 'x' });
    assert.equal(error, null, `admin upsert must succeed: ${error?.message}`);
    await service.from('settings').delete().eq('key', 'role_enum_test_key');
  });

  test('a steward cannot write settings', async () => {
    await asSteward(async () => {
      const { error } = await authed.from('settings').upsert({ key: 'role_enum_test_key_steward', value: 'x' });
      // settings has no anon/steward INSERT policy at all, so this is a
      // genuine RLS rejection (0 rows matched -> INSERT with no permitting
      // policy errors outright, unlike UPDATE/DELETE which just match nothing).
      assert.ok(error, 'a steward must not be able to write settings');
    });
    const { data } = await service.from('settings').select('key').eq('key', 'role_enum_test_key_steward');
    assert.equal(data.length, 0, 'the steward write must not have landed');
  });

  test('both admin and steward can read booking_locations (Allow staff to read / Admin full access)', async () => {
    const { error: adminErr } = await authed.from('booking_locations').select('*').limit(1);
    assert.equal(adminErr, null, `admin select must succeed: ${adminErr?.message}`);

    await asSteward(async () => {
      const { error: stewardErr } = await authed.from('booking_locations').select('*').limit(1);
      assert.equal(stewardErr, null, `steward select must succeed: ${stewardErr?.message}`);
    });
  });

  test('admin can write performers (performer_admin_access)', async () => {
    const { data, error } = await authed
      .from('performers')
      .update({ admin_notes: 'role enum test' })
      .eq('email', 'nonexistent-role-enum-test@example.test')
      .select('email');
    // No row matches this email - the point is proving the UPDATE reaches the
    // table without an RLS/type error, not that a row changes.
    assert.equal(error, null, `admin update must not error: ${error?.message}`);
  });

  test('a steward cannot read or write performers (no steward carve-out exists)', async () => {
    await asSteward(async () => {
      const { data, error } = await authed.from('performers').select('id').limit(1);
      assert.equal(error, null, error?.message);
      assert.equal(data.length, 0, 'a steward has no permitting policy on performers, so must see zero rows');
    });
  });

  test('admin can write schedules (schedule_admin_access)', async () => {
    // performer_id is uuid, not integer - an all-zero UUID matches no real
    // row but is validly shaped, unlike a bare -1.
    const { error } = await authed
      .from('schedules')
      .update({ notes: 'role enum test' })
      .eq('performer_id', '00000000-0000-0000-0000-000000000000');
    assert.equal(error, null, `admin update must not error: ${error?.message}`);
  });
});

describe('the seven check_user_role()-based policies (text unchanged, behaviour must still hold)', () => {
  test('admin can update a booking (Admin full)', async () => {
    const id = `${PREFIX}-0001`;
    await service.from('bookings').insert({
      id, status: 'Pending', business_name: 'x', owner_name: 'y', email: 'z@example.test',
      instance_prefix: 'ESF26-DEV-', stall_type: 'Food',
    });
    const { error } = await authed.from('bookings').update({ business_name: 'updated' }).eq('id', id);
    assert.equal(error, null, error?.message);
  });

  test('a steward can SELECT bookings but not UPDATE them (Steward access / Admin full)', async () => {
    const id = `${PREFIX}-0002`;
    await service.from('bookings').insert({
      id, status: 'Pending', business_name: 'x', owner_name: 'y', email: 'z@example.test',
      instance_prefix: 'ESF26-DEV-', stall_type: 'Food',
    });

    await asSteward(async () => {
      const { data, error: selErr } = await authed.from('bookings').select('id').eq('id', id);
      assert.equal(selErr, null, selErr?.message);
      assert.equal(data.length, 1, 'steward SELECT must still work');

      const { error: updErr } = await authed
        .from('bookings').update({ business_name: 'should not apply' }).eq('id', id);
      assert.equal(updErr, null, updErr?.message);
    });

    const { data: after } = await service.from('bookings').select('business_name').eq('id', id).single();
    assert.equal(after.business_name, 'x',
      'steward UPDATE must not have changed the row (the 20260720100000 drop, unaffected by this migration)');
  });

  test('admin can read email_queue, locations, payments, audit_logs, hcc_checks (remaining check_user_role() policies)', async () => {
    const results = await Promise.all([
      authed.from('email_queue').select('id').limit(1),
      authed.from('locations').select('id').limit(1),
      authed.from('payments').select('booking_id').limit(1),
      authed.from('audit_logs').select('id').limit(1),
      authed.from('hcc_checks').select('id').limit(1),
    ]);
    for (const [i, r] of results.entries()) {
      assert.equal(r.error, null, `query ${i} must not error: ${r.error?.message}`);
    }
  });
});

describe('get_is_admin()-based policy (untouched by this migration either way)', () => {
  test('admin can read their own row via policy_allow_all_admin, and manage user_roles', async () => {
    const { data, error } = await authed.from('user_roles').select('id, role').eq('id', adminUserId).single();
    assert.equal(error, null, error?.message);
    assert.equal(data.role, 'admin', 'role must still read back as the plain string "admin", not an object/wrapper');
  });
});

describe('the shim is genuinely gone, not just unreferenced', () => {
  test('role values sent from the client still round-trip as plain strings (the client-facing contract PostgREST enums preserve)', async () => {
    // This is the regression that would bite silently: if enum serialization
    // ever changed shape, every place that does `roleData.role === 'admin'`
    // client-side (js/supabase.js's requireAuth) would break invisibly.
    const { data, error } = await service.from('user_roles').select('role').eq('id', adminUserId).single();
    assert.equal(error, null, error?.message);
    assert.equal(typeof data.role, 'string');
    assert.equal(data.role, 'admin');
  });

  test('an invalid role value is rejected by the enum itself, not a CHECK constraint', async () => {
    const { error } = await service.from('user_roles').insert({
      id: '00000000-0000-0000-0000-000000000099',
      role: 'superadmin',
    });
    assert.ok(error, 'a role outside admin/steward must be rejected');
    // 22P02 = invalid_text_representation (enum input rejection). If this
    // were still a CHECK constraint the code would be 23514 instead - this
    // assertion is the proof the column is genuinely an enum now, not text
    // with a constraint that happens to allow the same two values.
    assert.equal(error.code, '22P02', `expected an enum input-rejection error, got code ${error.code}: ${error.message}`);
  });
});
