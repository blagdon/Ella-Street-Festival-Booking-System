// tests/phase3-dev-location-retirement.test.mjs
// Multi-Event Architecture Phase 3 — DEV location/test-data retirement.
//
// Migrations: 20260815100000 (WP1 location ownership, no DEV exception),
// 20260815210000 (deletes all locations.dataset='DEV' rows and the two
// explicitly-approved test bookings + their dependent records).
//
// 20260815210000 is a one-time data-cleanup migration, not reusable logic —
// it has already run against this test project (and, once separately
// approved, will run once against production). It is intentionally NOT
// re-tested here as if it were a repeatable function: the two booking ids
// it targets (ESF26-FOOD-0041, ESF26-NONFOOD-0919) are production-specific
// and never existed in this test project. Instead:
//   - the invariant the migration is meant to establish ("no non-LIVE
//     locations remain") is verified directly against live data;
//   - the CLEANUP PATTERN the migration uses (delete dependents, then the
//     booking) is verified generically, against a disposable fixture built
//     with the same shape, so the pattern is proven correct independent of
//     whether this specific project ever held the real rows;
//   - that deleting DEV-dataset locations does not disturb an unrelated
//     LIVE-dataset location's own booking_locations row is verified
//     directly.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { service, ensureFoundationRows } from './helpers.mjs';

before(async () => {
  await ensureFoundationRows(service);
});

describe('DEV location dataset — retired, no rows remain', () => {
  test('no locations row anywhere has a non-LIVE dataset', async () => {
    const { data, error } = await service.from('locations').select('id, dataset').neq('dataset', 'LIVE');
    assert.ifError(error);
    assert.equal((data || []).length, 0,
      `expected zero non-LIVE locations after the DEV retirement migration, found: ${JSON.stringify(data)}`);
  });
});

describe('DEV retirement cleanup pattern (mirrors 20260815210000, against a disposable fixture)', () => {
  const RUN_ID = Date.now();
  const SCRATCH_BOOKING = `ESF26-DEVCLEANUP-${RUN_ID}`;
  const SCRATCH_LOCATION = `DEVCLEANUP-LOC-${RUN_ID}`;

  before(async () => {
    await service.from('locations').insert({
      id: SCRATCH_LOCATION, dataset: 'LIVE', org_id: 'org_default', event_id: 'event_default', lat: 0, lng: 0,
    });
    await service.from('bookings').insert({
      id: SCRATCH_BOOKING, org_id: 'org_default', event_id: 'event_default', status: 'Confirmed',
      business_name: 'DEV Cleanup Pattern Fixture', owner_name: 'Test', email: 'test@example.test',
      instance_prefix: 'ESF26-FOOD-', stall_type: 'Food', booking_type: 'food',
      payment_link_code: `${SCRATCH_BOOKING}-code`,
    });
    await service.from('booking_locations').insert({ booking_id: SCRATCH_BOOKING, location_id: SCRATCH_LOCATION });
    await service.from('payments').insert({ booking_id: SCRATCH_BOOKING, org_id: 'org_default', paid: true, bank_ref: 'devcleanup-fixture' });
    await service.from('audit_logs').insert({ action: 'devcleanup_fixture', target_id: SCRATCH_BOOKING, org_id: 'org_default', event_id: 'event_default', details: {} });
  });

  after(async () => {
    // Idempotent: the test itself is expected to have already removed all
    // of these — this only mops up if an assertion failed mid-test.
    await service.from('payments').delete().eq('booking_id', SCRATCH_BOOKING);
    await service.from('audit_logs').delete().eq('target_id', SCRATCH_BOOKING);
    await service.from('booking_locations').delete().eq('booking_id', SCRATCH_BOOKING);
    await service.from('hcc_checks').delete().eq('booking_id', SCRATCH_BOOKING);
    await service.from('bookings').delete().eq('id', SCRATCH_BOOKING);
    await service.from('locations').delete().eq('id', SCRATCH_LOCATION).eq('dataset', 'LIVE');
  });

  test('deleting dependents then the booking removes every associated row, exactly as 20260815210000 does', async () => {
    const { error: payErr } = await service.from('payments').delete().eq('booking_id', SCRATCH_BOOKING);
    assert.ifError(payErr);
    const { error: auditErr } = await service.from('audit_logs').delete().eq('target_id', SCRATCH_BOOKING);
    assert.ifError(auditErr);
    const { error: blErr } = await service.from('booking_locations').delete().eq('booking_id', SCRATCH_BOOKING);
    assert.ifError(blErr);
    const { error: hccErr } = await service.from('hcc_checks').delete().eq('booking_id', SCRATCH_BOOKING);
    assert.ifError(hccErr);
    const { error: bookErr } = await service.from('bookings').delete().eq('id', SCRATCH_BOOKING);
    assert.ifError(bookErr);

    const [{ data: payments }, { data: audit }, { data: bl }, { data: bookings }] = await Promise.all([
      service.from('payments').select('booking_id').eq('booking_id', SCRATCH_BOOKING),
      service.from('audit_logs').select('id').eq('target_id', SCRATCH_BOOKING),
      service.from('booking_locations').select('id').eq('booking_id', SCRATCH_BOOKING),
      service.from('bookings').select('id').eq('id', SCRATCH_BOOKING),
    ]);
    assert.equal((payments || []).length, 0, 'payments row should be gone');
    assert.equal((audit || []).length, 0, 'audit_logs rows should be gone');
    assert.equal((bl || []).length, 0, 'booking_locations row should be gone');
    assert.equal((bookings || []).length, 0, 'the booking itself should be gone');

    // The fixture's own LIVE location must survive — this migration deletes
    // bookings and DEV-dataset locations, never a LIVE-dataset location.
    const { data: loc } = await service.from('locations').select('id').eq('id', SCRATCH_LOCATION).eq('dataset', 'LIVE');
    assert.equal((loc || []).length, 1, 'the fixture\'s own LIVE location must not have been touched');
  });
});

describe('deleting DEV-dataset locations leaves unrelated LIVE booking-location assignments intact', () => {
  const RUN_ID = Date.now();
  const LIVE_BOOKING = `ESF26-DEVSAFE-${RUN_ID}`;
  const LIVE_LOCATION = `DEVSAFE-LIVE-${RUN_ID}`;
  const DEV_LOCATION = `DEVSAFE-DEV-${RUN_ID}`;

  before(async () => {
    await service.from('locations').insert([
      { id: LIVE_LOCATION, dataset: 'LIVE', org_id: 'org_default', event_id: 'event_default', lat: 0, lng: 0 },
      { id: DEV_LOCATION, dataset: 'DEV', org_id: 'org_default', event_id: 'event_default', lat: 0, lng: 0 },
    ]);
    await service.from('bookings').insert({
      id: LIVE_BOOKING, org_id: 'org_default', event_id: 'event_default', status: 'Confirmed',
      business_name: 'DEV-Safety Fixture', owner_name: 'Test', email: 'test@example.test',
      instance_prefix: 'ESF26-FOOD-', stall_type: 'Food', booking_type: 'food',
      payment_link_code: `${LIVE_BOOKING}-code`,
    });
    await service.from('booking_locations').insert({ booking_id: LIVE_BOOKING, location_id: LIVE_LOCATION });
  });

  after(async () => {
    await service.from('booking_locations').delete().eq('booking_id', LIVE_BOOKING);
    await service.from('bookings').delete().eq('id', LIVE_BOOKING);
    await service.from('locations').delete().eq('id', LIVE_LOCATION).eq('dataset', 'LIVE');
    await service.from('locations').delete().eq('id', DEV_LOCATION).eq('dataset', 'DEV');
  });

  test('deleting the DEV-dataset location does not remove the LIVE booking_locations assignment', async () => {
    const { error } = await service.from('locations').delete().eq('id', DEV_LOCATION).eq('dataset', 'DEV');
    assert.ifError(error);

    const { data: bl } = await service.from('booking_locations').select('location_id').eq('booking_id', LIVE_BOOKING);
    assert.equal((bl || []).length, 1, 'the real booking\'s LIVE location assignment must survive');
    assert.equal(bl[0].location_id, LIVE_LOCATION);

    const { data: liveLoc } = await service.from('locations').select('id').eq('id', LIVE_LOCATION).eq('dataset', 'LIVE');
    assert.equal((liveLoc || []).length, 1, 'the LIVE location row itself must be untouched');
  });
});
