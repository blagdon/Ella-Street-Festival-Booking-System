// Regression tests for Phase 2E: booking_locations now has a real
// composite FK to locations (location_id, dataset) -> locations(id, dataset)
// ON DELETE CASCADE, plus a new dataset column (NOT NULL DEFAULT 'LIVE',
// CHECK dataset = 'LIVE'). Previously booking_locations.location_id had NO
// FK at all - only the booking_locations_check_conflict() trigger and
// rpc_set_booking_locations's own pre-check protected it, and only for
// those two write paths.
//
// The FK enforces existence only (does this (location_id, dataset) row
// exist at all) - it CANNOT and does not attempt to enforce that the
// location belongs to the same org/event as the referencing booking. That
// remains the trigger's and the RPC's job exclusively (see
// tests/rpc-authorisation.test.mjs's "location ownership hardening" suite
// for that coverage) and is not duplicated here.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, service } from './helpers.mjs';

function genTestPassword() {
  return randomUUID() + randomUUID().slice(0, 8).toUpperCase() + '!';
}

const RUN_ID = Date.now();
const ORG = `org-bl-fk-${RUN_ID}`;
const EVENT = `${ORG}-evt`;
const BOOKING = `BLFK-${RUN_ID}`;
const LOCATION = `${ORG}-LOC-${RUN_ID}`;
const NONEXISTENT_LOCATION = `bl-fk-nonexistent-${RUN_ID}`;
const ADMIN_EMAIL = `bl-fk-admin-${RUN_ID}@example.test`;
const ADMIN_PASSWORD = genTestPassword();

let ownerAdmin, ownerAdminId;

describe('booking_locations.location_id: composite FK to locations(id, dataset), ON DELETE CASCADE', () => {
  before(async () => {
    const { error: orgErr } = await service.from('organisations').insert({ id: ORG, name: 'Booking Locations FK Org', slug: ORG });
    assert.equal(orgErr, null, orgErr?.message);
    const { error: evtErr } = await service.from('events').insert({
      id: EVENT, org_id: ORG, name: 'Booking Locations FK Event', slug: `${ORG}-evt`,
      booking_prefix: `BLFK${RUN_ID.toString().slice(-6)}`, status: 'open',
    });
    assert.equal(evtErr, null, evtErr?.message);
    const { error: bErr } = await service.from('bookings').insert({
      id: BOOKING, org_id: ORG, event_id: EVENT, status: 'Confirmed', business_name: 'x', owner_name: 'y',
      email: 'z@example.test', instance_prefix: `${ORG}-`, booking_type: 'general', stall_cost: 10,
    });
    assert.equal(bErr, null, bErr?.message);
    const { error: locErr } = await service.from('locations').insert({
      id: LOCATION, dataset: 'LIVE', org_id: ORG, event_id: EVENT, lat: 51.0, lng: -0.1,
    });
    assert.equal(locErr, null, locErr?.message);

    // rpc_set_booking_locations checks is_authorised_for_org() internally
    // (unlike RLS, this is not bypassed by the service role) - a real org
    // admin is needed to exercise it, matching rpc-authorisation.test.mjs's
    // own pattern.
    const { data: adminCreated, error: adminErr } = await service.auth.admin.createUser({
      email: ADMIN_EMAIL, password: ADMIN_PASSWORD, email_confirm: true,
    });
    assert.equal(adminErr, null, adminErr?.message);
    ownerAdminId = adminCreated.user.id;
    const { error: memberErr } = await service.from('organisation_members').insert({ org_id: ORG, user_id: ownerAdminId, role: 'admin' });
    assert.equal(memberErr, null, memberErr?.message);
    ownerAdmin = createClient(url, anonKey);
    const { error: signInErr } = await ownerAdmin.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    assert.equal(signInErr, null, signInErr?.message);
  });

  after(async () => {
    await service.from('booking_locations').delete().eq('booking_id', BOOKING);
    await service.from('locations').delete().eq('id', LOCATION).eq('dataset', 'LIVE');
    await service.from('bookings').delete().eq('id', BOOKING);
    await service.from('events').delete().eq('id', EVENT);
    await service.from('organisation_members').delete().eq('org_id', ORG);
    await service.from('organisations').delete().eq('id', ORG);
    if (ownerAdminId) await service.auth.admin.deleteUser(ownerAdminId);
  });

  test('rpc_set_booking_locations (the real write path) still assigns a valid location unchanged', async () => {
    const { error } = await ownerAdmin.rpc('rpc_set_booking_locations', {
      p_booking_id: BOOKING, p_location_ids: [LOCATION],
    });
    assert.equal(error, null, error?.message);

    const { data, error: selErr } = await service.from('booking_locations').select('location_id, dataset').eq('booking_id', BOOKING);
    assert.equal(selErr, null, selErr?.message);
    assert.equal(data.length, 1);
    assert.equal(data[0].location_id, LOCATION);
    assert.equal(data[0].dataset, 'LIVE', 'new dataset column defaults to LIVE without the RPC needing to specify it');
  });

  test('a direct insert referencing a nonexistent location is rejected (by the trigger first, the FK as a backstop)', async () => {
    // booking_locations_check_conflict() fires BEFORE this row is written
    // and already does its own NOT EXISTS check for "a LIVE location
    // matching this booking's own org/event" - a location that doesn't
    // exist at all trivially fails that same check, so the trigger raises
    // its own P0001 here before the new FK ever gets evaluated. This is
    // expected, not a gap: the trigger's existence-plus-ownership check is
    // strictly stronger than the FK's existence-only check for every
    // INSERT/UPDATE this trigger covers. The FK's own, non-redundant
    // contribution is proven separately below (ON DELETE CASCADE, which
    // the trigger cannot express at all) and exists as defense-in-depth
    // for any hypothetical future write path that bypasses this trigger.
    const { error } = await service.from('booking_locations').insert({ booking_id: BOOKING, location_id: NONEXISTENT_LOCATION });
    assert.ok(error, 'a location_id with no matching (id, dataset) row must be rejected');
    assert.equal(error.code, 'P0001');
    assert.match(error.message, /does not belong to this booking's organisation\/event/);
  });

  test('the existing valid assignment remains valid and selectable', async () => {
    const { data, error } = await service.from('booking_locations').select('location_id').eq('booking_id', BOOKING).single();
    assert.equal(error, null, error?.message);
    assert.equal(data.location_id, LOCATION);
  });

  test('deleting the location CASCADEs to remove the booking_locations row (fulfils the admin UI\'s existing "will be unassigned" promise)', async () => {
    const { error } = await service.from('locations').delete().eq('id', LOCATION).eq('dataset', 'LIVE');
    assert.equal(error, null, error?.message);

    const { data } = await service.from('booking_locations').select('id').eq('booking_id', BOOKING);
    assert.equal(data.length, 0, 'the booking_locations row must be gone, not orphaned, once its location is deleted');
  });
});
