// tests/phase2-tenant-isolation.test.mjs
// Phase 2 — Tenant Awareness, RLS Isolation & Normalisation acceptance tests.
//
// Verifies deliverables from Phase 2:
// 1. booking_type column normalisation on bookings table.
// 2. organisation_members RPC authentication & check_user_role integration.
// 3. get_current_org_id dynamic resolution & tenant RLS policies.
//
// Runs against the disposable test Supabase project only (enforced in helpers.mjs).

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { service, url, anonKey, adminEmail, adminPassword, ensureFoundationRows } from './helpers.mjs';

let admin;

before(async () => {
  await ensureFoundationRows(service);

  admin = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await admin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Admin sign-in failed: ${error.message}`);
});

// ── 1. booking_type Normalisation ───────────────────────────────────────────────
describe('booking_type normalisation', () => {
  it('every existing booking has a valid booking_type', async () => {
    const { data, error } = await service.from('bookings').select('id, booking_type, instance_prefix').limit(100);
    assert.ifError(error);
    assert.ok(data.length > 0, 'bookings table should have test rows');

    const validTypes = new Set(['food', 'general', 'misc', 'dev']);
    data.forEach(b => {
      assert.ok(validTypes.has(b.booking_type), `Booking ${b.id} has invalid booking_type: ${b.booking_type}`);
    });
  });

  it('new booking receives default booking_type dev when omitted', async () => {
    const testId = `ESF26-DEV-PH2-TYPE-${Date.now()}`;
    const { error: insErr } = await service.from('bookings').insert({
      id: testId,
      instance_prefix: 'ESF26-DEV-',
      status: 'Pending',
      business_name: 'Phase2 Type Test',
      owner_name: 'Test Owner',
      email: 'ph2-type@example.test',
    });
    assert.ifError(insErr);

    const { data, error: selErr } = await service
      .from('bookings')
      .select('id, booking_type, instance_prefix')
      .eq('id', testId)
      .single();
    assert.ifError(selErr);
    assert.equal(data.booking_type, 'dev');
    assert.equal(data.instance_prefix, 'ESF26-DEV-');

    // Cleanup
    await service.from('bookings').delete().eq('id', testId);
  });
});

// ── 2. organisation_members RPC Security ───────────────────────────────────────
describe('organisation_members RPC security', () => {
  it('check_user_role returns true for admin present in organisation_members', async () => {
    const { data, error } = await admin.rpc('check_user_role', { required_role: 'admin' });
    assert.ifError(error);
    assert.equal(data, true);
  });

  it('check_user_role returns false for steward checking admin role', async () => {
    const { data, error } = await admin.rpc('check_user_role', { required_role: 'steward' });
    assert.ifError(error);
    // admin email has 'admin' role, not 'steward'
    assert.equal(data, false);
  });

  it('rpc_get_next_misc_id succeeds for authenticated admin', async () => {
    const { data, error } = await admin.rpc('rpc_get_next_misc_id');
    assert.ifError(error);
    assert.ok(typeof data === 'string' && data.includes('-MISC-'));
  });
});

// ── 3. Tenant Isolation & get_current_org_id ────────────────────────────────────
describe('tenant isolation & get_current_org_id', () => {
  it('get_current_org_id resolves org_default for active session', async () => {
    const { data, error } = await admin.rpc('get_current_org_id');
    assert.ifError(error);
    assert.equal(data, 'org_default');
  });

  it('admin can read organisations scoped by RLS', async () => {
    const { data, error } = await admin.from('organisations').select('id, name').eq('id', 'org_default').single();
    assert.ifError(error);
    assert.equal(data.id, 'org_default');
  });

  it('admin can read events scoped by RLS', async () => {
    const { data, error } = await admin.from('events').select('id, name, booking_prefix').eq('id', 'event_default').single();
    assert.ifError(error);
    assert.equal(data.id, 'event_default');
    assert.equal(data.booking_prefix, 'ESF26');
  });

  it('ensureFoundationRows seeds secondary test tenant org_demo and event_demo', async () => {
    const { data: org, error: orgErr } = await service.from('organisations').select('id, name').eq('id', 'org_demo').single();
    assert.ifError(orgErr);
    assert.equal(org.id, 'org_demo');

    const { data: evt, error: evtErr } = await service.from('events').select('id, org_id, booking_prefix').eq('id', 'event_demo').single();
    assert.ifError(evtErr);
    assert.equal(evt.id, 'event_demo');
    assert.equal(evt.org_id, 'org_demo');
    assert.equal(evt.booking_prefix, 'DEMO26');
  });

  it('admin can insert and update events', async () => {
    const eventId = `event_test_${Date.now()}`;
    const { error: insertErr } = await admin.from('events').insert({
      id: eventId,
      org_id: 'org_default',
      name: 'Test Event Edition',
      slug: `test-event-${Date.now()}`,
      booking_prefix: 'TEST26',
      is_active: true
    });
    assert.ifError(insertErr);

    const { error: updateErr } = await admin.from('events').update({
      name: 'Updated Test Event Edition'
    }).eq('id', eventId);
    assert.ifError(updateErr);

    await service.from('events').delete().eq('id', eventId);
  });
});

// ── 4. Platform Context Module ──────────────────────────────────────────────────
describe('Platform Context Module', () => {
  it('getPlatformContext returns valid structure with default org_id and event_id', async () => {
    const { getPlatformContext } = await import('../js/config.js');
    const ctx = getPlatformContext();
    assert.equal(ctx.orgId, 'org_default');
    assert.equal(ctx.eventId, 'event_default');
    assert.equal(typeof ctx.instance, 'string');
    assert.ok(ctx.urls);
  });
});

