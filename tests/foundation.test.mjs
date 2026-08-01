// tests/foundation.test.mjs
// Phase 1 — Multi-Tenant Foundation acceptance tests.
//
// Verifies that every deliverable from implementation_plan.md Phase 1 is
// present and structurally correct in the test project. These tests are
// intentionally not exhaustive business-logic tests — they are schema and
// data-shape assertions that would catch a migration that was never applied,
// a seed row that failed silently, or a column that was dropped by accident.
//
// Runs against the disposable test Supabase project only (enforced in
// helpers.mjs). Must pass before the Phase 1 branch is merged to main.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { service, url, anonKey, adminEmail, adminPassword, ensureFoundationRows } from './helpers.mjs';

// ── Admin client (signed-in) ─────────────────────────────────────────────────
let admin;
before(async () => {
  await ensureFoundationRows(service);

  admin = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await admin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Admin sign-in failed: ${error.message}`);
});

// ── 1. organisations table ───────────────────────────────────────────────────
describe('organisations table', () => {
  it('exists and has the org_default seed row', async () => {
    const { data, error } = await service.from('organisations').select('*').eq('id', 'org_default').single();
    assert.ifError(error);
    assert.equal(data.id,   'org_default');
    assert.equal(data.name, 'Ella Street Festival');
    assert.equal(data.slug, 'ella-street');
    assert.ok(data.created_at, 'created_at should be set');
  });

  it('admin can read organisations', async () => {
    const { data, error } = await admin.from('organisations').select('id').eq('id', 'org_default').single();
    assert.ifError(error);
    assert.equal(data.id, 'org_default');
  });

  it('anon cannot read organisations', async () => {
    const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await anon.from('organisations').select('id');
    // RLS should deny anon access — data should be empty or error returned
    const hasAccess = !error && data && data.length > 0;
    assert.equal(hasAccess, false, 'Anon should not be able to read organisations');
  });
});

// ── 2. events table ──────────────────────────────────────────────────────────
describe('events table', () => {
  it('exists and has the event_default seed row', async () => {
    const { data, error } = await service.from('events').select('*').eq('id', 'event_default').single();
    assert.ifError(error);
    assert.equal(data.id,             'event_default');
    assert.equal(data.org_id,         'org_default');
    assert.equal(data.name,           'Ella Street Festival 2026');
    assert.equal(data.slug,           'esf-2026');
    assert.equal(data.booking_prefix, 'ESF26');
    assert.equal(data.is_active,      true);
  });

  it('event_default references a valid org_id', async () => {
    const { data, error } = await service
      .from('events')
      .select('org_id, organisations!inner(id)')
      .eq('id', 'event_default')
      .single();
    assert.ifError(error);
    assert.equal(data.org_id, 'org_default');
  });

  it('admin can read events', async () => {
    const { data, error } = await admin.from('events').select('id').eq('id', 'event_default').single();
    assert.ifError(error);
    assert.equal(data.id, 'event_default');
  });

  it('anon cannot read events', async () => {
    const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await anon.from('events').select('id');
    const hasAccess = !error && data && data.length > 0;
    assert.equal(hasAccess, false, 'Anon should not be able to read events');
  });
});

// ── 3. organisation_members table ────────────────────────────────────────────
describe('organisation_members table', () => {
  it('exists and has the same member count as user_roles', async () => {
    const { data: members, error: mErr } = await service.from('organisation_members').select('user_id');
    const { data: roles,   error: rErr } = await service.from('user_roles').select('id');
    assert.ifError(mErr);
    assert.ifError(rErr);
    assert.equal(
      members.length, roles.length,
      `organisation_members (${members.length}) should match user_roles (${roles.length})`
    );
  });

  it('all organisation_members rows reference org_default', async () => {
    const { data, error } = await service
      .from('organisation_members')
      .select('org_id')
      .neq('org_id', 'org_default');
    assert.ifError(error);
    assert.equal(data.length, 0, 'All Phase 1 organisation_members should have org_id = org_default');
  });

  it('roles in organisation_members match user_roles', async () => {
    const { data: members } = await service
      .from('organisation_members')
      .select('user_id, role')
      .order('user_id');
    const { data: roles } = await service
      .from('user_roles')
      .select('id, role')
      .order('id');

    assert.ok(members.length > 0, 'organisation_members should not be empty');
    members.forEach((m, i) => {
      assert.equal(m.user_id, roles[i].id,   `user_id mismatch at index ${i}`);
      assert.equal(m.role,    roles[i].role,  `role mismatch for user_id ${m.user_id}`);
    });
  });

  it('admin can read organisation_members', async () => {
    const { data, error } = await admin.from('organisation_members').select('id');
    assert.ifError(error);
    assert.ok(Array.isArray(data));
  });
});

// ── 4. Tenant columns on domain tables ───────────────────────────────────────
describe('tenant columns on domain tables', () => {
  const tablesToCheck = [
    { table: 'bookings',        hasEventId: true  },
    { table: 'locations',       hasEventId: true  },
    { table: 'email_templates', hasEventId: false },
    { table: 'sms_templates',   hasEventId: false },
    { table: 'audit_logs',      hasEventId: true  },
    { table: 'hcc_checks',      hasEventId: true  },
    { table: 'payments',        hasEventId: false },
    { table: 'email_queue',     hasEventId: false },
    { table: 'sms_queue',       hasEventId: false },
  ];

  for (const { table, hasEventId } of tablesToCheck) {
    it(`${table} has org_id column queryable via PostgREST`, async () => {
      const { error } = await service.from(table).select('org_id').limit(1);
      assert.ifError(error, `${table}.org_id should be a queryable column`);
    });

    if (hasEventId) {
      it(`${table} has event_id column queryable via PostgREST`, async () => {
        const { error } = await service.from(table).select('event_id').limit(1);
        assert.ifError(error, `${table}.event_id should be a queryable column`);
      });
    }
  }
});

// ── 5. settings table composite PK ──────────────────────────────────────────
describe('settings table composite PK', () => {
  it('settings has org_id column queryable via PostgREST', async () => {
    const { error } = await service.from('settings').select('org_id').limit(1);
    assert.ifError(error, 'settings.org_id should be a queryable column');
  });

  it('settings supports composite PK (org_id, key)', async () => {
    // Prove composite PK works by inserting/upserting a key under a different org_id
    const testKey = `test_composite_pk_${Date.now()}`;
    const { error: ins1 } = await service.from('settings').upsert(
      { org_id: 'org_default', key: testKey, value: 'val1' },
      { onConflict: 'org_id,key' }
    );
    assert.ifError(ins1);

    const { error: ins2 } = await service.from('settings').upsert(
      { org_id: 'org_other_test', key: testKey, value: 'val2' },
      { onConflict: 'org_id,key' }
    );
    assert.ifError(ins2, 'Should allow same key under different org_id');

    // Both rows must exist concurrently
    const { data, error: selErr } = await service
      .from('settings')
      .select('org_id, key, value')
      .eq('key', testKey);
    assert.ifError(selErr);
    assert.equal(data.length, 2, 'Two settings rows with same key under different org_id should exist');

    // Cleanup
    await service.from('settings').delete().eq('key', testKey);
  });

  it('loadStallCosts()-equivalent SELECT still returns all settings rows', async () => {
    // This mirrors exactly what loadStallCosts() does: SELECT key, value FROM settings.
    // After the PK change, this must still return all rows.
    const { data, error } = await service.from('settings').select('key, value');
    assert.ifError(error);
    assert.ok(data.length >= 4, `Expected at least 4 settings rows, got ${data.length}`);

    const hasPrefix = data.some(r => r.key === 'booking_prefix');
    assert.ok(hasPrefix, 'booking_prefix setting should be present');
  });

  it('all existing settings rows have org_id = org_default', async () => {
    const { data, error } = await service
      .from('settings')
      .select('key, org_id')
      .neq('org_id', 'org_default');
    assert.ifError(error);
    assert.equal(data.length, 0, 'All Phase 1 settings rows should have org_id = org_default');
  });
});

// ── 6. RLS helper functions ──────────────────────────────────────────────────
describe('RLS helper functions', () => {
  it('get_current_org_id() returns org_default', async () => {
    const { data, error } = await service.rpc('get_current_org_id');
    assert.ifError(error);
    assert.equal(data, 'org_default');
  });

  it('get_current_event_id() returns event_default', async () => {
    const { data, error } = await service.rpc('get_current_event_id');
    assert.ifError(error);
    assert.equal(data, 'event_default');
  });

  it('get_current_org_id() works for authenticated admin', async () => {
    const { data, error } = await admin.rpc('get_current_org_id');
    assert.ifError(error);
    assert.equal(data, 'org_default');
  });
});

// ── 7. Backwards compatibility — existing behaviour unchanged ────────────────
describe('backwards compatibility', () => {
  it('instance_prefix column still exists on bookings', async () => {
    const { error } = await service.from('bookings').select('instance_prefix').limit(1);
    assert.ifError(error, 'instance_prefix must remain a queryable column on bookings');
  });

  it('user_roles table still exists and is unchanged', async () => {
    const { data, error } = await service.from('user_roles').select('id, role, email').limit(1);
    assert.ifError(error);
    assert.ok(Array.isArray(data), 'user_roles should still be queryable');
  });

  it('new booking insert without specifying org_id/event_id gets correct defaults', async () => {
    const testId = `ESF26-DEV-FOUNDATION-TEST-${Date.now()}`;
    const { error: insErr } = await service.from('bookings').insert({
      id:              testId,
      instance_prefix: 'ESF26-DEV-',
      status:          'Pending',
      business_name:   'Foundation Test Co',
      owner_name:      'Test Owner',
      email:           'foundation-test@example.test',
    });
    assert.ifError(insErr);

    const { data, error: selErr } = await service
      .from('bookings')
      .select('id, org_id, event_id, instance_prefix')
      .eq('id', testId)
      .single();
    assert.ifError(selErr);
    assert.equal(data.org_id,          'org_default',   'org_id default should apply');
    assert.equal(data.event_id,        'event_default',  'event_id default should apply');
    assert.equal(data.instance_prefix, 'ESF26-DEV-',    'instance_prefix should be preserved');

    // Clean up
    await service.from('bookings').delete().eq('id', testId);
  });

  it('settings can still be read by key name alone (no org_id filter required in Phase 1)', async () => {
    const { data, error } = await service
      .from('settings')
      .select('value')
      .eq('key', 'booking_prefix')
      .single();
    assert.ifError(error);
    assert.equal(data.value, 'ESF26');
  });
});
