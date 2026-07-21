// Behavioural tests for scoping anon's SELECT access on `schedules`
// (20260721081500_scope_anon_schedules_policy.sql).
//
// Production held zero schedules rows when this was written, so there was
// nothing to observe live risk against — these fixtures are what actually
// prove the new EXISTS subquery filters correctly, both ways (hides a
// non-approved performer's slot, still shows an approved one).
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

if (!url || !url.includes('qeplpcnrkgpaawfyliap')) {
  throw new Error(`Refusing to run integration tests against a non-test project: ${url}`);
}

const anon = createClient(url, anonKey);
const service = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

const NAME_PREFIX = 'SchedAnonScopeTest';
const LOCATION_ID = 'TESTLOC-SCHEDANON';
let applicantId, scheduledId, applicantSlotId, scheduledSlotId;

function performerFixture(status) {
  return {
    name: `${NAME_PREFIX} ${status}`,
    address: '1 Test Street',
    email: `sched-anon-${status.toLowerCase()}@example.test`,
    phone: '07000000000',
    description: 'Integration test performer',
    performance_type: 'Music',
    cost_per_30min: 10,
    status,
  };
}

before(async () => {
  await service.from('locations').upsert({ id: LOCATION_ID, dataset: 'DEV', lat: 0, lng: 0 });

  const { data: applicant, error: aErr } = await service.from('performers').insert(performerFixture('Applied')).select('id').single();
  assert.equal(aErr, null, aErr?.message);
  applicantId = applicant.id;

  const { data: scheduled, error: sErr } = await service.from('performers').insert(performerFixture('Scheduled')).select('id').single();
  assert.equal(sErr, null, sErr?.message);
  scheduledId = scheduled.id;

  const slotBase = {
    start_time: '10:00:00',
    end_time: '10:30:00',
    duration_minutes: 30,
    event_date: '2026-06-13',
    location: LOCATION_ID,
    dataset: 'DEV',
  };

  const { data: applicantSlot, error: asErr } = await service.from('schedules')
    .insert({ ...slotBase, performer_id: applicantId }).select('id').single();
  assert.equal(asErr, null, asErr?.message);
  applicantSlotId = applicantSlot.id;

  const { data: scheduledSlot, error: ssErr } = await service.from('schedules')
    .insert({ ...slotBase, performer_id: scheduledId, start_time: '11:00:00', end_time: '11:30:00' }).select('id').single();
  assert.equal(ssErr, null, ssErr?.message);
  scheduledSlotId = scheduledSlot.id;
});

after(async () => {
  await service.from('schedules').delete().in('performer_id', [applicantId, scheduledId].filter(Boolean));
  await service.from('performers').delete().like('name', `${NAME_PREFIX}%`);
  await service.from('locations').delete().eq('id', LOCATION_ID);
});

describe('anon schedules row-level scoping (20260721081500)', () => {
  test("anon cannot see a schedule slot for an Applied (non-approved) performer", async () => {
    const { data, error } = await anon.from('schedules').select('id, performer_id').eq('id', applicantSlotId);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 0, 'a non-Scheduled/Paid performer\'s slot must be invisible to anon on the base table');
  });

  test('anon can still see a schedule slot for a Scheduled performer (matches public_schedule_info)', async () => {
    const { data, error } = await anon.from('schedules').select('id, performer_id, start_time, end_time, duration_minutes, event_date').eq('id', scheduledSlotId);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 1, 'a Scheduled performer\'s slot must remain visible - this must not become a second, stricter public_schedule_info');
    assert.equal(data[0].performer_id, scheduledId);
  });

  test('anon still cannot select columns outside the existing grant, even on a now-visible row', async () => {
    // location/dataset/notes/paid_status are not anon-granted columns - this
    // migration only touches the row filter, not column grants, so this
    // must still fail exactly as it did before.
    const { error } = await anon.from('schedules').select('location').eq('id', scheduledSlotId);
    assert.ok(error, 'anon must still be rejected selecting a non-granted column');
  });

  test('the view and the now-filtered table agree on what anon can see', async () => {
    const { data: viewRows } = await anon.from('public_schedule_info').select('id').eq('id', scheduledSlotId);
    const { data: tableRows } = await anon.from('schedules').select('id').eq('id', scheduledSlotId);
    assert.equal(viewRows.length, 1);
    assert.equal(tableRows.length, 1);

    const { data: viewHidden } = await anon.from('public_schedule_info').select('id').eq('id', applicantSlotId);
    const { data: tableHidden } = await anon.from('schedules').select('id').eq('id', applicantSlotId);
    assert.equal(viewHidden.length, 0);
    assert.equal(tableHidden.length, 0);
  });

  test('admin (schedule_admin_access) still sees every slot regardless of performer status - unaffected by this migration', async () => {
    const { data, error } = await service.from('schedules').select('id').in('id', [applicantSlotId, scheduledSlotId]);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 2, 'service_role bypasses RLS entirely and must see both fixture rows regardless');
  });
});
