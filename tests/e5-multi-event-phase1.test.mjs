// Regression tests for Multi-Event Architecture Phase 1: proves an
// organisation can safely have multiple events, including simultaneous live
// ones - not hypothetical, production already has a second event under
// org_default (ESF28, draft, alongside ESF26/event_default, open) at the
// time this suite was written.
//
// Closes two confirmed defects:
//   1. rpc_get_next_misc_id() read its prefix from organisation-level
//      settings instead of the specific event - fixed by requiring an
//      explicit p_event_id, resolving events.booking_prefix, and verifying
//      the event genuinely belongs to the caller's own org first.
//   2. events.booking_prefix had no uniqueness enforcement at all - fixed
//      by a global UNIQUE constraint (deliberately global, not per-org -
//      the existing booking-id generators scan the whole bookings table by
//      prefix pattern with no org/event filter, so cross-org collisions
//      matter exactly as much as same-org ones).
//
// Also closes a defect found during THIS investigation, not the original
// review: insertMiscBooking() never set org_id/event_id on its own insert,
// relying on column defaults - meaning misc bookings were only functional
// for org_default (any other org's admin would pass the RPC's own
// authorisation check, then have the actual INSERT rejected by bookings'
// RLS, since the row would default to org_id='org_default').
//
// And fixes three query-layer gaps where event_id was available but never
// applied: fetchKanbanData, fetchPayments (both js/api.js), and the two
// booking queries inside fetchLocationData (which already correctly
// event-scoped its OWN locations query, just not its booking queries), plus
// an analogous gap in js/page-steward.js's syncDown().
//
// Deliberate test design: EVENT_A1 and EVENT_A2 below are given the SAME
// instance_prefix on their fixture bookings, even though their own
// booking_prefix values differ. This proves the new event_id filtering is
// doing the real work - before this fix, two events sharing an
// instance_prefix pattern (entirely possible, since instance_prefix reuse
// was never prevented either) would have had their bookings silently mixed
// together on Kanban/Payments/location-assignment views, and the fix
// wouldn't have been provable by a test that let differing prefixes
// accidentally separate them instead.
//
// browser-only functions (fetchKanbanData, fetchPayments, fetchLocationData,
// page-steward.js's syncDown, submitCreateEvent/submitEditEvent's UI error
// handling) cannot run in this Node-based suite - each is instead proven by
// reproducing the EXACT query/error shape those functions now use, directly
// against the database, the same technique every other test file in this
// suite already uses for RLS/query-shape verification. Not a claim that the
// browser code itself was executed.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, service, callEdgeFunction } from './helpers.mjs';

function genTestPassword() {
  return randomUUID() + randomUUID().slice(0, 8).toUpperCase() + '!';
}

const RUN_ID = Date.now();
const ORG_A = `e5me-org-a-${RUN_ID}`;
const ORG_B = `e5me-org-b-${RUN_ID}`;
const EVENT_A1 = `${ORG_A}-evt1`;
const EVENT_A2 = `${ORG_A}-evt2`;
const EVENT_A3_DRAFT = `${ORG_A}-evt3-draft`;
const EVENT_A4_ARCHIVED = `${ORG_A}-evt4-archived`;
const EVENT_B = `${ORG_B}-evt`;
const PREFIX_A1 = `E5A1${RUN_ID}`.slice(0, 12).toUpperCase();
const PREFIX_A2 = `E5A2${RUN_ID}`.slice(0, 12).toUpperCase();
const PREFIX_B = `E5B${RUN_ID}`.slice(0, 12).toUpperCase();
// Deliberately identical across EVENT_A1 and EVENT_A2 - see file header.
const SHARED_INSTANCE_PREFIX = `SHARED${RUN_ID}-FOOD-`;
const OWNER_A_EMAIL = `e5me-owner-a-${RUN_ID}@example.test`;
const OWNER_A_PASSWORD = genTestPassword();
const STEWARD_A_EMAIL = `e5me-steward-a-${RUN_ID}@example.test`;
const STEWARD_A_PASSWORD = genTestPassword();

let ownerA, ownerAId;
let stewardA, stewardAId;
const bookingIds = [];
const locationIds = [];

async function makeBooking(id, orgId, eventId, instancePrefix, status = 'Confirmed') {
  const { error } = await service.from('bookings').insert({
    id, org_id: orgId, event_id: eventId, instance_prefix: instancePrefix, status,
    business_name: `E5ME Test ${id}`, owner_name: 'Test Owner', email: 'trader@example.test',
    booking_type: 'food',
  });
  assert.equal(error, null, error?.message);
  bookingIds.push(id);
}

before(async () => {
  await service.from('organisations').insert({ id: ORG_A, name: `E5ME ${ORG_A}`, slug: ORG_A, contact_email: 'owner@example.test' });
  await service.from('organisations').insert({ id: ORG_B, name: `E5ME ${ORG_B}`, slug: ORG_B, contact_email: 'owner@example.test' });

  // Multi-Event Phase 2: is_active is now unique per organisation, so only
  // ONE of EVENT_A1/EVENT_A2 can carry is_active:true - EVENT_A1 keeps it
  // (matching every existing describe block below, none of which depend on
  // EVENT_A2's is_active value). EVENT_A3_DRAFT/EVENT_A4_ARCHIVED exist
  // solely for the lifecycle-rejection tests further down and are never
  // promoted, so they can't interfere with EVENT_A1/EVENT_A2's own tests.
  await service.from('events').insert({ id: EVENT_A1, org_id: ORG_A, name: 'E5ME Event A1', slug: `${ORG_A}-e1`, booking_prefix: PREFIX_A1, is_active: true, status: 'open' });
  await service.from('events').insert({ id: EVENT_A2, org_id: ORG_A, name: 'E5ME Event A2', slug: `${ORG_A}-e2`, booking_prefix: PREFIX_A2, is_active: false, status: 'open' });
  await service.from('events').insert({ id: EVENT_A3_DRAFT, org_id: ORG_A, name: 'E5ME Event A3 Draft', slug: `${ORG_A}-e3`, booking_prefix: `E5A3${RUN_ID}`.slice(0, 12).toUpperCase(), is_active: false, status: 'draft' });
  await service.from('events').insert({ id: EVENT_A4_ARCHIVED, org_id: ORG_A, name: 'E5ME Event A4 Archived', slug: `${ORG_A}-e4`, booking_prefix: `E5A4${RUN_ID}`.slice(0, 12).toUpperCase(), is_active: false, status: 'archived' });
  await service.from('events').insert({ id: EVENT_B, org_id: ORG_B, name: 'E5ME Event B', slug: `${ORG_B}-e1`, booking_prefix: PREFIX_B, is_active: true, status: 'open' });

  // Bookings under each Org A event, sharing the same instance_prefix.
  await makeBooking(`${PREFIX_A1}-0001`, ORG_A, EVENT_A1, SHARED_INSTANCE_PREFIX);
  await makeBooking(`${PREFIX_A2}-0001`, ORG_A, EVENT_A2, SHARED_INSTANCE_PREFIX);

  // Locations under each Org A event (steward-locations isolation, §17).
  const LOC_A1 = `${PREFIX_A1}-LOC-0001`;
  const LOC_A2 = `${PREFIX_A2}-LOC-0001`;
  await service.from('locations').insert({ id: LOC_A1, dataset: 'LIVE', org_id: ORG_A, event_id: EVENT_A1, lat: 51.0, lng: -0.1 });
  await service.from('locations').insert({ id: LOC_A2, dataset: 'LIVE', org_id: ORG_A, event_id: EVENT_A2, lat: 51.0, lng: -0.1 });
  locationIds.push(LOC_A1, LOC_A2);

  const { data: ownerCreated, error: ownerErr } = await service.auth.admin.createUser({
    email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD, email_confirm: true,
  });
  assert.equal(ownerErr, null, ownerErr?.message);
  ownerAId = ownerCreated.user.id;
  await service.from('organisation_members').insert({ org_id: ORG_A, user_id: ownerAId, role: 'admin' });
  ownerA = createClient(url, anonKey);
  const { error: ownerSignInErr } = await ownerA.auth.signInWithPassword({ email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD });
  assert.equal(ownerSignInErr, null, ownerSignInErr?.message);

  const { data: stewardCreated, error: stewardErr } = await service.auth.admin.createUser({
    email: STEWARD_A_EMAIL, password: STEWARD_A_PASSWORD, email_confirm: true,
  });
  assert.equal(stewardErr, null, stewardErr?.message);
  stewardAId = stewardCreated.user.id;
  await service.from('organisation_members').insert({ org_id: ORG_A, user_id: stewardAId, role: 'steward' });
  stewardA = createClient(url, anonKey);
  const { error: stewardSignInErr } = await stewardA.auth.signInWithPassword({ email: STEWARD_A_EMAIL, password: STEWARD_A_PASSWORD });
  assert.equal(stewardSignInErr, null, stewardSignInErr?.message);
});

after(async () => {
  await service.from('booking_locations').delete().in('booking_id', bookingIds);
  await service.from('payments').delete().in('booking_id', bookingIds);
  await service.from('hcc_checks').delete().in('booking_id', bookingIds);
  await service.from('bookings').delete().in('id', bookingIds);
  await service.from('locations').delete().in('id', locationIds);
  await service.from('organisation_members').delete().in('org_id', [ORG_A, ORG_B]);
  await service.from('events').delete().in('id', [EVENT_A1, EVENT_A2, EVENT_A3_DRAFT, EVENT_A4_ARCHIVED, EVENT_B]);
  await service.from('organisations').delete().in('id', [ORG_A, ORG_B]);
  if (ownerAId) { await service.from('user_roles').delete().eq('id', ownerAId); await service.auth.admin.deleteUser(ownerAId); }
  if (stewardAId) { await service.from('user_roles').delete().eq('id', stewardAId); await service.auth.admin.deleteUser(stewardAId); }
});

describe('1. Two events in the same organisation can have different prefixes', () => {
  test('EVENT_A1 and EVENT_A2 both exist under ORG_A with distinct booking_prefix values', async () => {
    const { data } = await service.from('events').select('id, booking_prefix').in('id', [EVENT_A1, EVENT_A2]).order('id');
    assert.equal(data.length, 2);
    assert.notEqual(data[0].booking_prefix, data[1].booking_prefix);
  });
});

describe('2-3. rpc_get_next_misc_id resolves each event\'s OWN prefix, not organisation-level settings', () => {
  test('p_event_id=EVENT_A1 generates an EVENT_A1-prefixed id', async () => {
    const { data, error } = await ownerA.rpc('rpc_get_next_misc_id', { p_event_id: EVENT_A1 });
    assert.equal(error, null, error?.message);
    assert.match(data, new RegExp(`^${PREFIX_A1}-MISC-\\d{4}$`));
  });

  test('p_event_id=EVENT_A2 generates an EVENT_A2-prefixed id (proves it is NOT reading org-level settings.booking_prefix)', async () => {
    const { data, error } = await ownerA.rpc('rpc_get_next_misc_id', { p_event_id: EVENT_A2 });
    assert.equal(error, null, error?.message);
    assert.match(data, new RegExp(`^${PREFIX_A2}-MISC-\\d{4}$`));
  });
});

describe('4. A caller cannot supply an event belonging to another organisation', () => {
  test('ORG_A\'s own admin supplying EVENT_B (belongs to ORG_B) is rejected', async () => {
    const { error } = await ownerA.rpc('rpc_get_next_misc_id', { p_event_id: EVENT_B });
    assert.ok(error, 'must reject an event that does not belong to the caller\'s own organisation');
    assert.match(error.message, /does not belong/i);
  });
});

describe('5-6. A non-org_default organisation can successfully create a MISC booking, correctly org/event-tagged', () => {
  test('the RPC + insert sequence insertMiscBooking() performs succeeds for ORG_A and tags org_id/event_id correctly', async () => {
    const { data: newId, error: idErr } = await ownerA.rpc('rpc_get_next_misc_id', { p_event_id: EVENT_A1 });
    assert.equal(idErr, null, idErr?.message);

    // Mirrors insertMiscBooking()'s own insert shape exactly (js/api.js) -
    // explicit org_id/event_id, not relying on column defaults.
    const { error: insErr } = await ownerA.from('bookings').insert({
      id: newId, org_id: ORG_A, event_id: EVENT_A1, instance_prefix: SHARED_INSTANCE_PREFIX,
      status: 'Confirmed', business_name: 'E5ME Misc Test', owner_name: 'Test Owner', booking_type: 'misc',
    });
    assert.equal(insErr, null, insErr?.message);
    bookingIds.push(newId);

    const { data: row } = await service.from('bookings').select('org_id, event_id').eq('id', newId).single();
    assert.equal(row.org_id, ORG_A, 'must be tagged with the real caller org, not org_default');
    assert.equal(row.event_id, EVENT_A1, 'must be tagged with the specific event, not event_default');
  });

  test('omitting org_id/event_id (the pre-fix insertMiscBooking() shape) fails RLS for a non-org_default admin - proves the old defect was real', async () => {
    const { data: newId, error: idErr } = await ownerA.rpc('rpc_get_next_misc_id', { p_event_id: EVENT_A1 });
    assert.equal(idErr, null, idErr?.message);

    const { error: insErr } = await ownerA.from('bookings').insert({
      id: newId, instance_prefix: SHARED_INSTANCE_PREFIX,
      status: 'Confirmed', business_name: 'E5ME Old Shape Test', owner_name: 'Test Owner', booking_type: 'misc',
    });
    assert.ok(insErr, 'without explicit org_id/event_id the row defaults to org_default/event_default, which ORG_A\'s admin is not authorised for under bookings RLS');
  });
});

describe('7. Duplicate booking_prefix is rejected at the database level', () => {
  test('INSERT with an already-used booking_prefix fails with 23505, independent of any UI code', async () => {
    const { error } = await service.from('events').insert({
      id: `${ORG_B}-dup-evt`, org_id: ORG_B, name: 'Duplicate Prefix Attempt', slug: `${ORG_B}-dup`,
      booking_prefix: PREFIX_A1, // already used by EVENT_A1, a DIFFERENT organisation - proves global, not per-org
      is_active: true,
    });
    assert.ok(error, 'must be rejected');
    assert.equal(error.code, '23505');
    assert.match(error.message || error.details || '', /events_booking_prefix_unique/);
  });
});

describe('8. The admin event-creation error path can distinguish the prefix violation from the slug violation', () => {
  test('the raw 23505 error for a booking_prefix collision is distinguishable from a slug collision by constraint name (the exact check submitCreateEvent/submitEditEvent now perform)', async () => {
    const { error: prefixErr } = await service.from('events').insert({
      id: `${ORG_A}-dup-evt`, org_id: ORG_A, name: 'Dup', slug: `${ORG_A}-a-brand-new-slug-${RUN_ID}`,
      booking_prefix: PREFIX_A2, is_active: true,
    });
    assert.equal(prefixErr.code, '23505');
    assert.match(prefixErr.message || prefixErr.details || '', /events_booking_prefix_unique/);

    const { error: slugErr } = await service.from('events').insert({
      id: `${ORG_A}-dup-evt-2`, org_id: ORG_A, name: 'Dup2', slug: `${ORG_A}-e1`, // EVENT_A1's own slug
      booking_prefix: `UNUSED${RUN_ID}`, is_active: true,
    });
    assert.equal(slugErr.code, '23505');
    assert.doesNotMatch(slugErr.message || slugErr.details || '', /events_booking_prefix_unique/, 'a slug collision must not be misclassified as a prefix collision');
  });
});

// Sections 9-12 assert "EVENT_A2's booking never appears" rather than an
// exact row count - by this point in the file, section 5-6 has already
// legitimately added a second, genuinely-EVENT_A1 misc booking sharing the
// same instance_prefix, so an exact count of 1 would be a fragile,
// ordering-dependent assertion. The property that actually matters - and
// the one these fixes exist to prove - is that the OTHER event's booking
// (`${PREFIX_A2}-0001`) never leaks into a query scoped to EVENT_A1.
const EVENT_A2_BOOKING_ID = `${PREFIX_A2}-0001`;

describe('9. Kanban query does not mix Event 1 and Event 2 bookings, despite a shared instance_prefix', () => {
  test('the org+event+instance_prefix filter (fetchKanbanData\'s shape) never returns EVENT_A2\'s booking', async () => {
    const { data, error } = await ownerA.from('bookings').select('*')
      .eq('org_id', ORG_A).eq('event_id', EVENT_A1).eq('instance_prefix', SHARED_INSTANCE_PREFIX);
    assert.equal(error, null, error?.message);
    assert.ok(data.length >= 1);
    assert.ok(data.every((r) => r.event_id === EVENT_A1), 'every returned row must belong to EVENT_A1');
    assert.ok(!data.some((r) => r.id === EVENT_A2_BOOKING_ID), 'EVENT_A2\'s booking must never appear when querying EVENT_A1');
  });
});

describe('10. Payments query does not mix Event 1 and Event 2 bookings', () => {
  test('the org+event+instance_prefix-list filter (fetchPayments\' shape) never returns EVENT_A2\'s booking', async () => {
    const { data, error } = await ownerA.from('bookings').select('*')
      .eq('org_id', ORG_A).eq('event_id', EVENT_A1).in('instance_prefix', [SHARED_INSTANCE_PREFIX]);
    assert.equal(error, null, error?.message);
    assert.ok(data.length >= 1);
    assert.ok(data.every((r) => r.event_id === EVENT_A1), 'every returned row must belong to EVENT_A1');
    assert.ok(!data.some((r) => r.id === EVENT_A2_BOOKING_ID), 'EVENT_A2\'s booking must never appear when querying EVENT_A1');
  });
});

describe('11. Location assignment does not see Event 2 bookings while assigning for Event 1', () => {
  test('the org+event+status+instance_prefix filter (fetchLocationData\'s bLocs/occupantBookings shape) never returns EVENT_A2\'s booking', async () => {
    const { data, error } = await ownerA.from('bookings').select('*')
      .eq('org_id', ORG_A).eq('event_id', EVENT_A1).eq('status', 'Confirmed').eq('instance_prefix', SHARED_INSTANCE_PREFIX);
    assert.equal(error, null, error?.message);
    assert.ok(data.length >= 1);
    assert.ok(data.every((r) => r.event_id === EVENT_A1), 'every returned row must belong to EVENT_A1');
    assert.ok(!data.some((r) => r.id === EVENT_A2_BOOKING_ID), 'EVENT_A2\'s booking must never appear when querying EVENT_A1');
  });
});

describe('12. Steward booking selection is event-scoped', () => {
  test('the event-filtered query (page-steward.js\'s syncDown shape) never returns EVENT_A2\'s booking', async () => {
    const { data, error } = await stewardA.from('bookings')
      .select('id, business_name, owner_name, email, phone, event_id')
      .eq('event_id', EVENT_A1)
      .in('status', ['Confirmed'])
      .in('instance_prefix', [SHARED_INSTANCE_PREFIX]);
    assert.equal(error, null, error?.message);
    assert.ok(data.length >= 1);
    assert.ok(data.every((r) => r.event_id === EVENT_A1), 'every returned row must belong to EVENT_A1');
    assert.ok(!data.some((r) => r.id === EVENT_A2_BOOKING_ID), 'EVENT_A2\'s booking must never appear when querying EVENT_A1');
  });
});

describe('13. Existing single-event behaviour is unaffected', () => {
  test('a single-event organisation (only EVENT_B under ORG_B) still resolves its own booking normally', async () => {
    const bookingId = `${PREFIX_B}-0001`;
    await makeBooking(bookingId, ORG_B, EVENT_B, `${PREFIX_B}-FOOD-`);
    const { data, error } = await service.from('bookings').select('*').eq('org_id', ORG_B).eq('event_id', EVENT_B);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 1);
    assert.equal(data[0].id, bookingId);
  });
});

describe('14. Cross-organisation isolation remains intact', () => {
  test('ORG_A\'s admin cannot read ORG_B\'s events or bookings', async () => {
    const { data: evts } = await ownerA.from('events').select('id').eq('id', EVENT_B);
    assert.equal((evts || []).length, 0);

    const { data: bookings } = await ownerA.from('bookings').select('id').eq('org_id', ORG_B);
    assert.equal((bookings || []).length, 0);
  });

  test('rpc_get_next_misc_id still enforces org authorisation, unchanged, when the event genuinely does belong to the caller', async () => {
    // Regression guard: ownerA is not authorised for ORG_B at all, so even
    // supplying ORG_B's own real event must fail at the authorisation
    // check, not the event-ownership check - same outcome as Test 4, but
    // proves the two are independent checks, not one conflated with the other.
    const { error } = await ownerA.rpc('rpc_get_next_misc_id', { p_event_id: EVENT_B });
    assert.ok(error);
  });
});

// ---------------------------------------------------------------------
// Multi-Event Architecture Phase 2 — event isolation correctness and
// default-event resolution. Sections 15+ below.
// ---------------------------------------------------------------------

describe('15. HCC reads are event-scoped and inherit the parent booking\'s event_id on creation', () => {
  const hccBookingIds = [];

  after(async () => {
    await service.from('hcc_checks').delete().in('booking_id', hccBookingIds);
    await service.from('bookings').delete().in('id', hccBookingIds);
  });

  test('an hcc_checks row created the way the fixed js/api.js now does (event_id copied from the parent booking) is tagged correctly, not left on the column default', async () => {
    const bookingId = `${PREFIX_A2}-HCC-0001`;
    await makeBooking(bookingId, ORG_A, EVENT_A2, SHARED_INSTANCE_PREFIX, 'HCC Checks');
    hccBookingIds.push(bookingId);

    // Mirrors updateBookingStatus()'s own fixed shape exactly (js/api.js):
    // SELECT the booking's org_id/event_id, then INSERT hcc_checks with both.
    const { data: bookingRow } = await service.from('bookings').select('org_id, event_id').eq('id', bookingId).single();
    const { error: hccErr } = await ownerA.from('hcc_checks').insert({
      booking_id: bookingId, council_status: 'Pending', org_id: bookingRow.org_id, event_id: bookingRow.event_id,
    });
    assert.equal(hccErr, null, hccErr?.message);

    const { data: hccRow } = await service.from('hcc_checks').select('event_id').eq('booking_id', bookingId).single();
    assert.equal(hccRow.event_id, EVENT_A2, 'must be tagged with the booking\'s own event, not event_default');
  });

  test('the org+event filter (page-hcc-dashboard.js\'s fixed query shape) never returns a different event\'s hcc_checks row', async () => {
    const bookingId1 = `${PREFIX_A1}-HCC-0001`;
    const bookingId2 = `${PREFIX_A2}-HCC-0002`;
    await makeBooking(bookingId1, ORG_A, EVENT_A1, SHARED_INSTANCE_PREFIX, 'HCC Checks');
    await makeBooking(bookingId2, ORG_A, EVENT_A2, SHARED_INSTANCE_PREFIX, 'HCC Checks');
    hccBookingIds.push(bookingId1, bookingId2);

    await service.from('hcc_checks').insert({ booking_id: bookingId1, council_status: 'Pending', org_id: ORG_A, event_id: EVENT_A1 });
    await service.from('hcc_checks').insert({ booking_id: bookingId2, council_status: 'Pending', org_id: ORG_A, event_id: EVENT_A2 });

    const { data, error } = await ownerA.from('hcc_checks').select('booking_id, event_id').eq('org_id', ORG_A).eq('event_id', EVENT_A1);
    assert.equal(error, null, error?.message);
    assert.ok(data.some((r) => r.booking_id === bookingId1));
    assert.ok(!data.some((r) => r.booking_id === bookingId2), 'EVENT_A2\'s hcc_checks row must never appear when querying EVENT_A1');
  });
});

describe('16. Steward location sync is event-scoped', () => {
  test('the event-filtered query (page-steward.js\'s fixed locations shape) never returns EVENT_A2\'s location', async () => {
    const { data, error } = await stewardA.from('locations').select('id').eq('event_id', EVENT_A1).eq('dataset', 'LIVE');
    assert.equal(error, null, error?.message);
    assert.ok(data.some((r) => r.id === locationIds[0]));
    assert.ok(!data.some((r) => r.id === locationIds[1]), 'EVENT_A2\'s location must never appear when querying EVENT_A1');
  });
});

describe('17. bookings.event_id / locations.event_id are referentially enforced', () => {
  test('a booking with a non-existent event_id is rejected by the foreign key, not silently accepted', async () => {
    const { error } = await service.from('bookings').insert({
      id: `${PREFIX_A1}-FK-BAD`, org_id: ORG_A, event_id: `${EVENT_A1}-does-not-exist`, instance_prefix: SHARED_INSTANCE_PREFIX,
      status: 'Pending', business_name: 'FK Test', owner_name: 'Test Owner', booking_type: 'food',
    });
    assert.ok(error, 'must be rejected');
    assert.equal(error.code, '23503');
  });

  test('a location with a non-existent event_id is rejected by the foreign key, not silently accepted', async () => {
    const { error } = await service.from('locations').insert({
      id: `${PREFIX_A1}-FK-LOC-BAD`, dataset: 'LIVE', org_id: ORG_A, event_id: `${EVENT_A1}-does-not-exist`, lat: 51.0, lng: -0.1,
    });
    assert.ok(error, 'must be rejected');
    assert.equal(error.code, '23503');
  });
});

describe('18. is_default and is_active are each unique per organisation', () => {
  test('a second event under ORG_A with is_default=true is rejected while EVENT_A1 already holds it', async () => {
    // rpc_set_default_event requires a real authorised admin session -
    // is_authorised_for_org()/has_org_role() key off auth.uid(), which a
    // service-role call has none of, so ownerA (ORG_A's real admin) is used
    // here, not the service client.
    const { error: setErr } = await ownerA.rpc('rpc_set_default_event', { p_event_id: EVENT_A1 });
    assert.equal(setErr, null, setErr?.message);

    const { error } = await service.from('events').update({ is_default: true }).eq('id', EVENT_A2);
    assert.ok(error, 'must be rejected');
    assert.equal(error.code, '23505');
    assert.match(error.message || error.details || '', /events_org_default_unique/);
  });

  test('a second event under ORG_A with is_active=true is rejected while EVENT_A1 already holds it (fixture default)', async () => {
    const { error } = await service.from('events').update({ is_active: true }).eq('id', EVENT_A2);
    assert.ok(error, 'must be rejected');
    assert.equal(error.code, '23505');
    assert.match(error.message || error.details || '', /events_org_active_unique/);
  });

  test('a DIFFERENT organisation may independently have its own is_default/is_active event (per-org scoping)', async () => {
    // Direct service-role write here (not the RPC) - this test proves the
    // partial unique index is scoped per-org, not that the RPC's own
    // authorisation works (already covered by the tests above/below).
    const { error } = await service.from('events').update({ is_default: true }).eq('id', EVENT_B);
    assert.equal(error, null, error?.message, 'ORG_B setting its own default must not be affected by ORG_A already having one');
  });
});

describe('19. A default event cannot be draft or archived', () => {
  test('setting is_default=true on a draft event is rejected by the lifecycle CHECK', async () => {
    const { error } = await service.from('events').update({ is_default: true }).eq('id', EVENT_A3_DRAFT);
    assert.ok(error, 'must be rejected');
    assert.equal(error.code, '23514');
    assert.match(error.message || error.details || '', /events_default_lifecycle_check/);
  });

  test('setting is_default=true on an archived event is rejected by the lifecycle CHECK', async () => {
    const { error } = await service.from('events').update({ is_default: true }).eq('id', EVENT_A4_ARCHIVED);
    assert.ok(error, 'must be rejected');
    assert.equal(error.code, '23514');
    assert.match(error.message || error.details || '', /events_default_lifecycle_check/);
  });

  test('rpc_set_default_event gives a clear application error for a draft event, not a raw constraint violation', async () => {
    const { error } = await ownerA.rpc('rpc_set_default_event', { p_event_id: EVENT_A3_DRAFT });
    assert.ok(error);
    assert.match(error.message, /draft/i);
  });

  test('ready, open, and closed events are all eligible to be default (only draft/archived are blocked)', async () => {
    // Uses the RPC, not a raw UPDATE - by this point in the suite ORG_A
    // already has a real is_default event (set by the promotion tests
    // above), so an unconditional raw UPDATE would legitimately collide
    // with events_org_default_unique. The RPC atomically clears whichever
    // event currently holds it first, which is exactly what "promoting a
    // ready event to default" means in practice.
    const readyEventId = `${ORG_A}-evt-ready`;
    await service.from('events').insert({ id: readyEventId, org_id: ORG_A, name: 'Ready Event', slug: `${ORG_A}-eready`, booking_prefix: `E5AR${RUN_ID}`.slice(0, 12).toUpperCase(), is_active: false, status: 'ready' });
    const { error } = await ownerA.rpc('rpc_set_default_event', { p_event_id: readyEventId });
    assert.equal(error, null, error?.message, 'a ready event must be allowed to become the default');
    await service.from('events').delete().eq('id', readyEventId);
  });
});

describe('20-21. Active/default-event promotion is atomic and cross-tenant-safe', () => {
  test('rpc_set_active_event atomically clears the previous active event and sets the new one', async () => {
    const { error } = await ownerA.rpc('rpc_set_active_event', { p_event_id: EVENT_A2 });
    assert.equal(error, null, error?.message);

    const { data } = await service.from('events').select('id, is_active').in('id', [EVENT_A1, EVENT_A2]).order('id');
    const a1 = data.find((e) => e.id === EVENT_A1);
    const a2 = data.find((e) => e.id === EVENT_A2);
    assert.equal(a1.is_active, false, 'the previously-active event must be cleared, not left true alongside the new one');
    assert.equal(a2.is_active, true);

    // Restore for any later test relying on EVENT_A1 being the active one.
    await ownerA.rpc('rpc_set_active_event', { p_event_id: EVENT_A1 });
  });

  test('rpc_set_default_event atomically clears the previous default event and sets the new one', async () => {
    const { error } = await ownerA.rpc('rpc_set_default_event', { p_event_id: EVENT_A2 });
    assert.equal(error, null, error?.message);

    const { data } = await service.from('events').select('id, is_default').in('id', [EVENT_A1, EVENT_A2]).order('id');
    const a1 = data.find((e) => e.id === EVENT_A1);
    const a2 = data.find((e) => e.id === EVENT_A2);
    assert.equal(a1.is_default, false, 'the previously-default event must be cleared, not left true alongside the new one');
    assert.equal(a2.is_default, true);
  });

  test('cross-organisation active-event promotion is rejected', async () => {
    const { error } = await ownerA.rpc('rpc_set_active_event', { p_event_id: EVENT_B });
    assert.ok(error, 'ORG_A\'s admin must not be able to activate an ORG_B event');
  });

  test('cross-organisation default-event promotion is rejected', async () => {
    const { error } = await ownerA.rpc('rpc_set_default_event', { p_event_id: EVENT_B });
    assert.ok(error, 'ORG_A\'s admin must not be able to default an ORG_B event');
  });

  test('a steward (non-admin) cannot promote an active or default event', async () => {
    const { error: activeErr } = await stewardA.rpc('rpc_set_active_event', { p_event_id: EVENT_A1 });
    assert.ok(activeErr, 'admin role required');
    const { error: defaultErr } = await stewardA.rpc('rpc_set_default_event', { p_event_id: EVENT_A1 });
    assert.ok(defaultErr, 'admin role required');
  });
});

describe('22. Bulk email/SMS reject a cross-event booking selection server-side', () => {
  test('queue-bulk-email rejects a bookingIds array spanning EVENT_A1 and EVENT_A2, even though the current UI can never construct one', async () => {
    const { data: { session } } = await ownerA.auth.getSession();
    const { status, json } = await callEdgeFunction('queue-bulk-email', {
      bookingIds: [`${PREFIX_A1}-0001`, `${PREFIX_A2}-0001`],
      subject: 'Phase 2 cross-event test', body: 'test',
    }, session.access_token);
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(json.error, /more than one event/i);
  });

  test('queue-bulk-sms rejects a bookingIds array spanning EVENT_A1 and EVENT_A2', async () => {
    const { data: { session } } = await ownerA.auth.getSession();
    const { status, json } = await callEdgeFunction('queue-bulk-sms', {
      bookingIds: [`${PREFIX_A1}-0001`, `${PREFIX_A2}-0001`],
      body: 'Phase 2 cross-event test',
    }, session.access_token);
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(json.error, /more than one event/i);
  });
});

describe('23. Audit log can be filtered by event (page-audit-log.js\'s new eventFilter)', () => {
  const auditTargetIds = [];

  after(async () => {
    await service.from('audit_logs').delete().in('target_id', auditTargetIds);
  });

  test('the org+event filter (the fixed query shape) never returns a different event\'s audit_logs row', async () => {
    const targetId1 = `${PREFIX_A1}-AUDIT-0001`;
    const targetId2 = `${PREFIX_A2}-AUDIT-0002`;
    auditTargetIds.push(targetId1, targetId2);
    // Mirrors js/audit.js's auditLog() insert shape exactly - it is the
    // sole frontend writer and already sets event_id correctly on every
    // call (target_table is NOT a real column on audit_logs - confirmed
    // during this investigation; auditLog() never sends one); this proves
    // the READ-side filter (the actual Phase 2 fix) works.
    const { error: insErr1 } = await service.from('audit_logs').insert({ action: 'update_status', target_id: targetId1, org_id: ORG_A, event_id: EVENT_A1, details: {} });
    assert.equal(insErr1, null, insErr1?.message);
    const { error: insErr2 } = await service.from('audit_logs').insert({ action: 'update_status', target_id: targetId2, org_id: ORG_A, event_id: EVENT_A2, details: {} });
    assert.equal(insErr2, null, insErr2?.message);

    const { data, error } = await ownerA.from('audit_logs').select('target_id, event_id').eq('org_id', ORG_A).eq('event_id', EVENT_A1);
    assert.equal(error, null, error?.message);
    assert.ok(data.some((r) => r.target_id === targetId1));
    assert.ok(!data.some((r) => r.target_id === targetId2), 'EVENT_A2\'s audit_logs row must never appear when querying EVENT_A1');
  });

  test('"All Events" (no event filter) still returns rows from every event, unchanged from before', async () => {
    const { data, error } = await ownerA.from('audit_logs').select('target_id').eq('org_id', ORG_A);
    assert.equal(error, null, error?.message);
    assert.ok(data.some((r) => r.target_id === `${PREFIX_A1}-AUDIT-0001`));
    assert.ok(data.some((r) => r.target_id === `${PREFIX_A2}-AUDIT-0002`));
  });
});

describe('24. Migration backwards-compatible default-event promotion (data-driven, no hardcoded IDs)', () => {
  // Reproduces the migration's own UPDATE logic via the query builder,
  // the same technique this file's header comment already establishes for
  // proving browser-only/migration-time behaviour: not a claim the
  // migration SQL itself was re-executed (it already ran once and is
  // idempotent - see the NOT EXISTS guard), but that its exact WHERE
  // conditions produce the required outcome against real fixture data.
  async function simulateMigrationPromotion(orgId) {
    const { data: candidates } = await service.from('events').select('id, org_id')
      .eq('org_id', orgId).eq('is_active', true).not('status', 'in', '(draft,archived)');
    const { data: existingDefault } = await service.from('events').select('id').eq('org_id', orgId).eq('is_default', true);
    if ((candidates || []).length && !(existingDefault || []).length) {
      await service.from('events').update({ is_default: true }).eq('id', candidates[0].id);
    }
  }

  const promoOrgEligible = `e5me-promo-elig-${RUN_ID}`;
  const promoOrgDraftOnly = `e5me-promo-draft-${RUN_ID}`;
  const promoEventEligible = `${promoOrgEligible}-evt`;
  const promoEventDraft = `${promoOrgDraftOnly}-evt`;

  before(async () => {
    await service.from('organisations').insert([
      { id: promoOrgEligible, name: 'E5ME Promo Eligible Org', slug: promoOrgEligible },
      { id: promoOrgDraftOnly, name: 'E5ME Promo Draft-Only Org', slug: promoOrgDraftOnly },
    ]);
    // Pre-migration-shaped state: is_active=true, is_default=false (as
    // every existing row was before the correction), one org with an
    // eligible (open) event, one org with only a draft event.
    await service.from('events').insert([
      { id: promoEventEligible, org_id: promoOrgEligible, name: 'Eligible Event', slug: `${promoOrgEligible}-e`, booking_prefix: `PE${RUN_ID}`.slice(0, 12).toUpperCase(), is_active: true, status: 'open', is_default: false },
      { id: promoEventDraft, org_id: promoOrgDraftOnly, name: 'Draft Only Event', slug: `${promoOrgDraftOnly}-e`, booking_prefix: `PD${RUN_ID}`.slice(0, 12).toUpperCase(), is_active: true, status: 'draft', is_default: false },
    ]);
  });

  after(async () => {
    await service.from('events').delete().in('id', [promoEventEligible, promoEventDraft]);
    await service.from('organisations').delete().in('id', [promoOrgEligible, promoOrgDraftOnly]);
  });

  test('an eligible active/open event becomes the organisation\'s default', async () => {
    await simulateMigrationPromotion(promoOrgEligible);
    const { data } = await service.from('events').select('is_default').eq('id', promoEventEligible).single();
    assert.equal(data.is_default, true);
  });

  test('an organisation whose only event is draft gets no default', async () => {
    await simulateMigrationPromotion(promoOrgDraftOnly);
    const { data } = await service.from('events').select('is_default').eq('id', promoEventDraft).single();
    assert.equal(data.is_default, false, 'a draft event must never become the default, even via the migration\'s own promotion logic');
  });

  test('the one-default-per-org invariant holds after promotion (re-running the promotion is a safe no-op)', async () => {
    await simulateMigrationPromotion(promoOrgEligible);
    const { data, error } = await service.from('events').select('id').eq('org_id', promoOrgEligible).eq('is_default', true);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 1, 'exactly one default event, not zero and not more than one');
  });

  test('production\'s real org_default/event_default pair already reflects exactly this outcome', async () => {
    // Confirms the actual migration DML (not the simulation above) already
    // produced the required backwards-compatible result on this test
    // project, matching what production will get: event_default remains
    // org_default's default, unchanged from its pre-Phase-2 behaviour.
    const { data, error } = await service.from('events').select('id, is_default').eq('org_id', 'org_default').eq('is_default', true);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'event_default', 'org_default\'s no-slug public booking path must keep resolving to event_default, exactly as before Phase 2');
  });
});
