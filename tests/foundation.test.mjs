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
    it(`${table} has org_id column with default 'org_default'`, async () => {
      // information_schema check via service role
      const { data, error } = await service
        .from('information_schema.columns')
        .select('column_name, column_default, is_nullable')
        .eq('table_schema', 'public')
        .eq('table_name', table)
        .eq('column_name', 'org_id')
        .single();
      assert.ifError(error);
      assert.equal(data.column_name, 'org_id');
      assert.ok(
        data.column_default && data.column_default.includes('org_default'),
        `${table}.org_id default should be 'org_default', got: ${data.column_default}`
      );
      assert.equal(data.is_nullable, 'NO', `${table}.org_id should be NOT NULL`);
    });

    if (hasEventId) {
      it(`${table} has event_id column with default 'event_default'`, async () => {
        const { data, error } = await service
          .from('information_schema.columns')
          .select('column_name, column_default, is_nullable')
          .eq('table_schema', 'public')
          .eq('table_name', table)
          .eq('column_name', 'event_id')
          .single();
        assert.ifError(error);
        assert.equal(data.column_name, 'event_id');
        assert.ok(
          data.column_default && data.column_default.includes('event_default'),
          `${table}.event_id default should be 'event_default', got: ${data.column_default}`
        );
        assert.equal(data.is_nullable, 'NO', `${table}.event_id should be NOT NULL`);
      });
    }
  }
});

// ── 5. settings table composite PK ──────────────────────────────────────────
describe('settings table composite PK', () => {
  it('settings has org_id column', async () => {
    const { data, error } = await service
      .from('information_schema.columns')
      .select('column_name, column_default, is_nullable')
      .eq('table_schema', 'public')
      .eq('table_name', 'settings')
      .eq('column_name', 'org_id')
      .single();
    assert.ifError(error);
    assert.equal(data.column_name, 'org_id');
    assert.equal(data.is_nullable, 'NO');
  });

  it('settings PK is now (org_id, key)', async () => {
    const { data, error } = await service
      .from('information_schema.table_constraints')
      .select('constraint_name, constraint_type')
      .eq('table_schema', 'public')
      .eq('table_name', 'settings')
      .eq('constraint_type', 'PRIMARY KEY')
      .single();
    assert.ifError(error);
    assert.equal(data.constraint_type, 'PRIMARY KEY');

    // Verify the PK covers both columns
    const { data: cols, error: cErr } = await service
      .from('information_schema.key_column_usage')
      .select('column_name, ordinal_position')
      .eq('table_schema', 'public')
      .eq('table_name', 'settings')
      .eq('constraint_name', data.constraint_name)
      .order('ordinal_position');
    assert.ifError(cErr);
    assert.equal(cols.length, 2, 'Settings PK should cover exactly 2 columns');
    const colNames = cols.map(c => c.column_name);
    assert.ok(colNames.includes('org_id'), 'PK should include org_id');
    assert.ok(colNames.includes('key'),    'PK should include key');
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
    const { data, error } = await service
      .from('information_schema.columns')
      .select('column_name')
      .eq('table_schema', 'public')
      .eq('table_name', 'bookings')
      .eq('column_name', 'instance_prefix')
      .single();
    assert.ifError(error);
    assert.equal(data.column_name, 'instance_prefix',
      'instance_prefix must not be removed in Phase 1 — it is still the active filter mechanism');
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
