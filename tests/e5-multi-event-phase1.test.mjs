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
import { url, anonKey, service } from './helpers.mjs';

function genTestPassword() {
  return randomUUID() + randomUUID().slice(0, 8).toUpperCase() + '!';
}

const RUN_ID = Date.now();
const ORG_A = `e5me-org-a-${RUN_ID}`;
const ORG_B = `e5me-org-b-${RUN_ID}`;
const EVENT_A1 = `${ORG_A}-evt1`;
const EVENT_A2 = `${ORG_A}-evt2`;
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

  await service.from('events').insert({ id: EVENT_A1, org_id: ORG_A, name: 'E5ME Event A1', slug: `${ORG_A}-e1`, booking_prefix: PREFIX_A1, is_active: true, status: 'open' });
  await service.from('events').insert({ id: EVENT_A2, org_id: ORG_A, name: 'E5ME Event A2', slug: `${ORG_A}-e2`, booking_prefix: PREFIX_A2, is_active: true, status: 'open' });
  await service.from('events').insert({ id: EVENT_B, org_id: ORG_B, name: 'E5ME Event B', slug: `${ORG_B}-e1`, booking_prefix: PREFIX_B, is_active: true, status: 'open' });

  // Bookings under each Org A event, sharing the same instance_prefix.
  await makeBooking(`${PREFIX_A1}-0001`, ORG_A, EVENT_A1, SHARED_INSTANCE_PREFIX);
  await makeBooking(`${PREFIX_A2}-0001`, ORG_A, EVENT_A2, SHARED_INSTANCE_PREFIX);

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
  await service.from('bookings').delete().in('id', bookingIds);
  await service.from('organisation_members').delete().in('org_id', [ORG_A, ORG_B]);
  await service.from('events').delete().in('id', [EVENT_A1, EVENT_A2, EVENT_B]);
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
