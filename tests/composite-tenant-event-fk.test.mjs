// Regression tests for the Phase 2C composite tenant/event FK hardening
// (migration 20260821133124_composite_tenant_event_fk_hardening.sql):
// bookings_org_event_fkey / locations_org_event_fkey now enforce, at the
// database level, that a booking/location's event_id must belong to the
// SAME org_id — not merely that the event exists at all (the old
// single-column bookings_event_id_fkey / locations_event_id_fkey only ever
// checked the latter). Every test here uses the `service` (postgres) role,
// which bypasses RLS entirely, so a rejection here can only come from the
// FK constraint itself, not from an authorisation check — proving the
// database constraint, not application validation, is what's being
// exercised.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { service } from './helpers.mjs';

const RUN_ID = Date.now();
const ORG_A = `composite-fk-a-${RUN_ID}`;
const ORG_B = `composite-fk-b-${RUN_ID}`;
const EVENT_A = `${ORG_A}-evt`;
const EVENT_B = `${ORG_B}-evt`;
const BOOKING_A = `COMPFK-A-${RUN_ID}`;
const CROSS_ORG_BOOKING_ID = `COMPFK-CROSS-${RUN_ID}`;
const CROSS_ORG_LOCATION_ID = `${ORG_A}-CROSS-LOC-${RUN_ID}`;
const VALID_LOCATION_ID = `${ORG_A}-LOC-${RUN_ID}`;

// orgId.slice(-8) alone can collide the way rpc-authorisation.test.mjs's
// shortHash comment explains; reused here for the same reason (distinct
// booking_prefix per org, required by events_booking_prefix_unique).
function shortHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h.toString(36).toUpperCase().padStart(8, '0').slice(-8);
}

before(async () => {
  await service.from('organisations').insert([
    { id: ORG_A, name: `Composite FK Org A ${RUN_ID}`, slug: ORG_A, contact_email: 'owner-a@example.test' },
    { id: ORG_B, name: `Composite FK Org B ${RUN_ID}`, slug: ORG_B, contact_email: 'owner-b@example.test' },
  ]);
  await service.from('events').insert([
    { id: EVENT_A, org_id: ORG_A, name: `${ORG_A} Event`, slug: `${ORG_A}-evt`, booking_prefix: shortHash(EVENT_A), status: 'open' },
    { id: EVENT_B, org_id: ORG_B, name: `${ORG_B} Event`, slug: `${ORG_B}-evt`, booking_prefix: shortHash(EVENT_B), status: 'open' },
  ]);
  await service.from('bookings').insert({
    id: BOOKING_A, org_id: ORG_A, event_id: EVENT_A, status: 'Pending',
    business_name: 'Composite FK Test Co', owner_name: 'Test Owner', email: 'trader@example.test',
    instance_prefix: `${ORG_A}-`, booking_type: 'general', stall_cost: 50,
  });
});

after(async () => {
  await service.from('booking_locations').delete().in('booking_id', [BOOKING_A, CROSS_ORG_BOOKING_ID]);
  await service.from('locations').delete().in('id', [VALID_LOCATION_ID, CROSS_ORG_LOCATION_ID]);
  await service.from('bookings').delete().in('id', [BOOKING_A, CROSS_ORG_BOOKING_ID]);
  await service.from('events').delete().in('id', [EVENT_A, EVENT_B]);
  await service.from('organisations').delete().in('id', [ORG_A, ORG_B]);
});

describe('bookings_org_event_fkey rejects a cross-organisation event assignment (Phase 2C)', () => {
  test('INSERT: org_id belongs to Org A, event_id belongs to Org B is rejected by the database constraint', async () => {
    const { error } = await service.from('bookings').insert({
      id: CROSS_ORG_BOOKING_ID, org_id: ORG_A, event_id: EVENT_B, status: 'Pending',
      business_name: 'Cross Org Attempt', owner_name: 'Test Owner', email: 'trader@example.test',
      instance_prefix: `${ORG_A}-`, booking_type: 'general', stall_cost: 50,
    });
    assert.ok(error, 'a booking whose org_id does not own its event_id must be rejected');
    assert.equal(error.code, '23503', 'must be a foreign key violation, not some other rejection');
    assert.match(error.message, /bookings_org_event_fkey/, 'must be rejected specifically by the new composite FK, not an unrelated constraint');
  });

  test('UPDATE: moving an existing booking to an event owned by a DIFFERENT org is rejected by the database constraint', async () => {
    const { error } = await service.from('bookings').update({ event_id: EVENT_B }).eq('id', BOOKING_A);
    assert.ok(error, 'updating a booking to reference a different org\'s event must be rejected');
    assert.equal(error.code, '23503');
    assert.match(error.message, /bookings_org_event_fkey/);

    const { data: unchanged } = await service.from('bookings').select('event_id').eq('id', BOOKING_A).single();
    assert.equal(unchanged.event_id, EVENT_A, 'the rejected update must not have partially applied');
  });

  test('INSERT: a genuinely matching org_id/event_id pair still succeeds (regression guard)', async () => {
    const { error } = await service.from('bookings').insert({
      id: CROSS_ORG_BOOKING_ID, org_id: ORG_A, event_id: EVENT_A, status: 'Pending',
      business_name: 'Legitimate Same-Org Booking', owner_name: 'Test Owner', email: 'trader@example.test',
      instance_prefix: `${ORG_A}-`, booking_type: 'general', stall_cost: 50,
    });
    assert.equal(error, null, error?.message);
  });
});

describe('locations_org_event_fkey rejects a cross-organisation event assignment (Phase 2C)', () => {
  test('INSERT: org_id belongs to Org A, event_id belongs to Org B is rejected by the database constraint', async () => {
    const { error } = await service.from('locations').insert({
      id: CROSS_ORG_LOCATION_ID, dataset: 'LIVE', org_id: ORG_A, event_id: EVENT_B, lat: 51.0, lng: -0.1,
    });
    assert.ok(error, 'a location whose org_id does not own its event_id must be rejected');
    assert.equal(error.code, '23503');
    assert.match(error.message, /locations_org_event_fkey/);
  });

  test('UPDATE: moving an existing location to an event owned by a DIFFERENT org is rejected by the database constraint', async () => {
    const { error: seedErr } = await service.from('locations').insert({
      id: VALID_LOCATION_ID, dataset: 'LIVE', org_id: ORG_A, event_id: EVENT_A, lat: 51.0, lng: -0.1,
    });
    assert.equal(seedErr, null, seedErr?.message);

    const { error } = await service.from('locations').update({ event_id: EVENT_B }).eq('id', VALID_LOCATION_ID).eq('dataset', 'LIVE');
    assert.ok(error, 'updating a location to reference a different org\'s event must be rejected');
    assert.equal(error.code, '23503');
    assert.match(error.message, /locations_org_event_fkey/);

    const { data: unchanged } = await service.from('locations').select('event_id').eq('id', VALID_LOCATION_ID).eq('dataset', 'LIVE').single();
    assert.equal(unchanged.event_id, EVENT_A, 'the rejected update must not have partially applied');
  });

  test('a genuinely matching org_id/event_id pair still succeeds (regression guard, same row as above)', async () => {
    const { data } = await service.from('locations').select('org_id, event_id').eq('id', VALID_LOCATION_ID).eq('dataset', 'LIVE').single();
    assert.equal(data.org_id, ORG_A);
    assert.equal(data.event_id, EVENT_A);
  });
});
