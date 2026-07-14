// Behavioral security/RLS tests: actually call the REST API as a real
// unauthenticated anon caller and assert on what comes back, rather than
// diffing policy text (that's what rls_grants_snapshot.txt / check:rls-grants
// is for). This is the permanent version of the ad-hoc curl checks used to
// verify the locations DEV/LIVE fix and the bookings/performers column-grant
// investigations earlier this session. Runs against the disposable "test
// backup" Supabase project only - see integration.test.mjs for the same guard.
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

const confirmedBookingId = 'ESF26-TESTSEC-CONFIRMED';
const pendingBookingId = 'ESF26-TESTSEC-PENDING';
const scheduledPerformerId = '11111111-2222-3333-4444-555555555501';
const appliedPerformerId = '11111111-2222-3333-4444-555555555502';
const devLocationId = 'TESTSECLOC-DEV';
const liveLocationId = 'TESTSECLOC-LIVE';

before(async () => {
  await service.from('bookings').delete().in('id', [confirmedBookingId, pendingBookingId]);
  await service.from('performers').delete().in('id', [scheduledPerformerId, appliedPerformerId]);
  await service.from('locations').delete().in('id', [devLocationId, liveLocationId]);

  const { error: bookingsInsertErr } = await service.from('bookings').insert([
    {
      id: confirmedBookingId, status: 'Confirmed', business_name: 'Sec Test Confirmed',
      owner_name: 'Secret Owner', email: 'secret@example.test', phone: '07000000001',
      admin_notes: 'secret admin note', instance_prefix: 'ESF26-FOOD-', stall_type: 'Food',
    },
    {
      id: pendingBookingId, status: 'Pending', business_name: 'Sec Test Pending',
      owner_name: 'Secret Owner 2', email: 'secret2@example.test',
      instance_prefix: 'ESF26-FOOD-', stall_type: 'Food',
    },
  ]);
  if (bookingsInsertErr) throw new Error(`Fixture setup failed (bookings): ${bookingsInsertErr.message}`);

  const { error: performersInsertErr } = await service.from('performers').insert([
    {
      id: scheduledPerformerId, name: 'Sec Test Scheduled Performer', status: 'Scheduled',
      email: 'performer-secret@example.test', phone: '07000000002', address: '1 Secret St',
      description: 'Test performer', performance_type: 'Music', cost_per_30min: 0,
    },
    {
      id: appliedPerformerId, name: 'Sec Test Applied Performer', status: 'Applied',
      email: 'performer-secret2@example.test', phone: '07000000003', address: '2 Secret St',
      description: 'Test performer', performance_type: 'Music', cost_per_30min: 0,
    },
  ]);
  if (performersInsertErr) throw new Error(`Fixture setup failed (performers): ${performersInsertErr.message}`);

  const { error: locationsInsertErr } = await service.from('locations').insert([
    { id: devLocationId, dataset: 'DEV', lat: 0, lng: 0 },
    { id: liveLocationId, dataset: 'LIVE', lat: 0, lng: 0 },
  ]);
  if (locationsInsertErr) throw new Error(`Fixture setup failed (locations): ${locationsInsertErr.message}`);
});

after(async () => {
  await service.from('bookings').delete().in('id', [confirmedBookingId, pendingBookingId]);
  await service.from('performers').delete().in('id', [scheduledPerformerId, appliedPerformerId]);
  await service.from('locations').delete().in('id', [devLocationId, liveLocationId]);
});

describe('anon access to bookings', () => {
  test('Confirmed booking is visible through its permitted, non-sensitive columns', async () => {
    // The anon column grant on bookings is limited to id, business_name,
    // description, stall_type, category, instance_prefix - select('*')
    // requires implicit access to every column, so it doesn't silently drop
    // the disallowed ones, it errors outright (confirmed live: "permission
    // denied for table bookings"). A real anon consumer (js/api.js's
    // fetchMapData()) selects these exact columns explicitly, same as here.
    const { data, error } = await anon
      .from('bookings')
      .select('id, business_name, description, stall_type, category, instance_prefix')
      .eq('id', confirmedBookingId)
      .single();
    assert.equal(error, null, error?.message);
    assert.equal(data.business_name, 'Sec Test Confirmed');
  });

  test('anon cannot select a column outside the grant, even on a visible row', async () => {
    const { error } = await anon.from('bookings').select('email').eq('id', confirmedBookingId).single();
    assert.ok(error, 'expected selecting bookings.email as anon to be rejected outright');
  });

  test('Pending booking is not visible to anon at all', async () => {
    const { data, error } = await anon
      .from('bookings')
      .select('id, business_name, description, stall_type, category, instance_prefix')
      .eq('id', pendingBookingId);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 0, 'expected RLS to hide non-Confirmed bookings from anon entirely');
  });

  test('anon cannot write to bookings (no INSERT/UPDATE/DELETE policy exists)', async () => {
    const { error: insertErr } = await anon.from('bookings').insert({
      id: 'ESF26-TESTSEC-INJECT', status: 'Confirmed', business_name: 'Injected', instance_prefix: 'ESF26-FOOD-', stall_type: 'Food',
    });
    assert.ok(insertErr, 'expected anon INSERT on bookings to be rejected');

    // No UPDATE policy exists for anon at all, so this should error outright
    // (permission denied), not silently affect zero rows.
    const { error: updateErr } = await anon
      .from('bookings')
      .update({ business_name: 'Hacked' })
      .eq('id', confirmedBookingId);
    assert.ok(updateErr, 'expected anon UPDATE on bookings to be rejected');

    const { data: stillThere } = await service.from('bookings').select('business_name').eq('id', confirmedBookingId).single();
    assert.equal(stillThere.business_name, 'Sec Test Confirmed', 'the booking must be unchanged after the rejected anon update attempt');
  });
});

describe('anon access to performers', () => {
  test('Scheduled performer is visible through its permitted, non-sensitive columns', async () => {
    // Anon column grant on performers: id, name, description, performance_type,
    // performance_type_other, status - same reasoning as bookings above,
    // select explicit permitted columns rather than '*'.
    const { data, error } = await anon
      .from('performers')
      .select('id, name, description, performance_type, performance_type_other, status')
      .eq('id', scheduledPerformerId)
      .single();
    assert.equal(error, null, error?.message);
    assert.equal(data.name, 'Sec Test Scheduled Performer');
  });

  test('anon cannot select a column outside the grant, even on a visible row', async () => {
    const { error } = await anon.from('performers').select('email').eq('id', scheduledPerformerId).single();
    assert.ok(error, 'expected selecting performers.email as anon to be rejected outright');
  });

  test('Applied performer is not visible to anon at all', async () => {
    const { data, error } = await anon
      .from('performers')
      .select('id, name, description, performance_type, performance_type_other, status')
      .eq('id', appliedPerformerId);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 0, 'expected RLS to hide non-Scheduled/Paid performers from anon entirely');
  });
});

describe('anon access to locations', () => {
  test('DEV rows are never visible to anon, even unfiltered', async () => {
    const { data: unfiltered } = await anon.from('locations').select('id,dataset');
    assert.ok(!unfiltered.some((r) => r.dataset === 'DEV'), 'expected zero DEV rows in an unfiltered anon query');

    const { data: explicitDev } = await anon.from('locations').select('id').eq('id', devLocationId);
    assert.equal(explicitDev.length, 0, 'expected the specific DEV test row to be invisible to anon');

    const { data: explicitLive } = await anon.from('locations').select('id').eq('id', liveLocationId);
    assert.equal(explicitLive.length, 1, 'expected the LIVE test row to remain visible to anon');
  });
});

describe('anon access to admin-only tables', () => {
  test('user_roles is completely inaccessible to anon', async () => {
    // anon has zero table-level grants here at all (not just RLS-filtered) -
    // confirmed via fix_user_roles_and_schedules_grants.sql revoking
    // everything. PostgREST rejects the query outright rather than
    // returning an empty array.
    const { error } = await anon.from('user_roles').select('*');
    assert.ok(error, 'expected anon SELECT on user_roles to be rejected outright');
  });

  test('email_queue is completely inaccessible to anon', async () => {
    const { error } = await anon.from('email_queue').select('*');
    assert.ok(error, 'expected anon SELECT on email_queue to be rejected outright');
  });
});
