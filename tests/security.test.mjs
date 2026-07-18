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
const adminEmail = process.env.TEST_ADMIN_EMAIL;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;

if (!url || !url.includes('qeplpcnrkgpaawfyliap')) {
  throw new Error(`Refusing to run integration tests against a non-test project: ${url}`);
}

const anon = createClient(url, anonKey);
const service = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

// Mirrors workflow.test.mjs's admin client - a real authenticated admin
// session, subject to the same RLS as the live app. Only a "does the admin
// role boundary actually admit admin" check exists below (no steward test
// user exists in this project's fixtures yet to prove the negative case
// too - see email_queue.html's own admin-only gate in js/page-email-queue.js).
let admin;

const confirmedBookingId = 'ESF26-TESTSEC-CONFIRMED';
const pendingBookingId = 'ESF26-TESTSEC-PENDING';
const scheduledPerformerId = '11111111-2222-3333-4444-555555555501';
const appliedPerformerId = '11111111-2222-3333-4444-555555555502';
const deletedScheduledPerformerId = '11111111-2222-3333-4444-555555555503';
const devLocationId = 'TESTSECLOC-DEV';
const liveLocationId = 'TESTSECLOC-LIVE';
const emailQueueTestRecipient = 'sectest-emailqueue@example.test';

before(async () => {
  admin = createClient(url, anonKey);
  const { error: signInErr } = await admin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (signInErr) throw new Error(`Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${signInErr.message}`);

  await service.from('booking_locations').delete().in('booking_id', [confirmedBookingId, pendingBookingId]);
  await service.from('bookings').delete().in('id', [confirmedBookingId, pendingBookingId]);
  await service.from('performers').delete().in('id', [scheduledPerformerId, appliedPerformerId, deletedScheduledPerformerId]);
  await service.from('locations').delete().in('id', [devLocationId, liveLocationId]);
  await service.from('email_queue').delete().eq('recipient', emailQueueTestRecipient);

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
    {
      // Regression fixture for the 2026-07-16 permission-audit fix: a
      // Scheduled performer that's also soft-deleted (deleted_at set, as
      // the separate ellafestperformersadmin.vercel.app app does) must not
      // be visible to anon despite matching the Scheduled/Paid status filter.
      id: deletedScheduledPerformerId, name: 'Sec Test Deleted Scheduled Performer', status: 'Scheduled',
      email: 'performer-secret3@example.test', phone: '07000000004', address: '3 Secret St',
      description: 'Test performer', performance_type: 'Music', cost_per_30min: 0,
      deleted_at: new Date().toISOString(),
    },
  ]);
  if (performersInsertErr) throw new Error(`Fixture setup failed (performers): ${performersInsertErr.message}`);

  const { error: locationsInsertErr } = await service.from('locations').insert([
    { id: devLocationId, dataset: 'DEV', lat: 0, lng: 0 },
    { id: liveLocationId, dataset: 'LIVE', lat: 0, lng: 0 },
  ]);
  if (locationsInsertErr) throw new Error(`Fixture setup failed (locations): ${locationsInsertErr.message}`);

  // Give the confirmed booking a location, so the public_bookings_info
  // view's join and the booking_locations anon policy both have a real
  // row to exercise (the pending booking is deliberately left unassigned).
  const { error: bookingLocationsInsertErr } = await service.from('booking_locations').insert([
    { booking_id: confirmedBookingId, location_id: liveLocationId },
  ]);
  if (bookingLocationsInsertErr) throw new Error(`Fixture setup failed (booking_locations): ${bookingLocationsInsertErr.message}`);

  const { error: emailQueueInsertErr } = await service.from('email_queue').insert({
    recipient: emailQueueTestRecipient, subject: 'Sec test email', body: '<p>test</p>',
    status: 'Error', error_message: 'Sec test induced failure', instance_prefix: 'ESF26-FOOD-',
  });
  if (emailQueueInsertErr) throw new Error(`Fixture setup failed (email_queue): ${emailQueueInsertErr.message}`);
});

after(async () => {
  await service.from('booking_locations').delete().in('booking_id', [confirmedBookingId, pendingBookingId]);
  await service.from('bookings').delete().in('id', [confirmedBookingId, pendingBookingId]);
  await service.from('performers').delete().in('id', [scheduledPerformerId, appliedPerformerId, deletedScheduledPerformerId]);
  await service.from('locations').delete().in('id', [devLocationId, liveLocationId]);
  await service.from('email_queue').delete().eq('recipient', emailQueueTestRecipient);
});

describe('anon access to bookings', () => {
  // 2026-07-15 security fix: a third-party review correctly flagged that
  // the "Public see confirmed" RLS policy let anon SELECT any Confirmed
  // row, relying entirely on column-level GRANTs (see git history) as the
  // only thing narrowing which columns that exposed — a single future
  // `GRANT SELECT ON bookings TO anon` would have silently undone that.
  // The policy and those column grants are now both gone; anon has zero
  // access to the bookings table itself, full stop. Public consumers
  // (js/api.js's fetchMapData()) go through the public_bookings_info view
  // instead — see the next describe block.
  test('anon cannot select from bookings at all, even the previously-permitted columns', async () => {
    const { data, error } = await anon
      .from('bookings')
      .select('id, business_name, description, stall_type, category, instance_prefix')
      .eq('id', confirmedBookingId)
      .single();
    assert.ok(error, 'expected selecting even the old permitted-column set as anon to be rejected outright');
    assert.equal(data, null);
  });

  test('anon cannot select any single column from bookings, confirmed or not', async () => {
    const { error: confirmedErr } = await anon.from('bookings').select('id').eq('id', confirmedBookingId).single();
    assert.ok(confirmedErr, 'expected selecting bookings.id as anon to be rejected outright');

    const { error: pendingErr } = await anon.from('bookings').select('id').eq('id', pendingBookingId).single();
    assert.ok(pendingErr, 'expected selecting bookings.id as anon to be rejected outright');
  });

  test('anon cannot select a PII column from bookings', async () => {
    const { error } = await anon.from('bookings').select('email').eq('id', confirmedBookingId).single();
    assert.ok(error, 'expected selecting bookings.email as anon to be rejected outright');
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

describe('anon access to public_bookings_info (replaces direct bookings access)', () => {
  test('Confirmed booking is visible through the view, with its assigned location', async () => {
    const { data, error } = await anon
      .from('public_bookings_info')
      .select('id, business_name, category, stall_type, description, instance_prefix, location_id')
      .eq('id', confirmedBookingId)
      .single();
    assert.equal(error, null, error?.message);
    assert.equal(data.business_name, 'Sec Test Confirmed');
    assert.equal(data.location_id, liveLocationId);
  });

  test('the view has no PII columns to select at all', async () => {
    const { error } = await anon.from('public_bookings_info').select('email').eq('id', confirmedBookingId).single();
    assert.ok(error, 'expected selecting a non-existent PII column on the view to be rejected');
  });

  test('Pending booking is not visible through the view (not Confirmed)', async () => {
    const { data, error } = await anon.from('public_bookings_info').select('id').eq('id', pendingBookingId);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 0, 'expected the view to hide non-Confirmed bookings from anon entirely');
  });

  test('anon cannot write to the view', async () => {
    const { error } = await anon.from('public_bookings_info').update({ business_name: 'Hacked' }).eq('id', confirmedBookingId);
    assert.ok(error, 'expected anon UPDATE on the view to be rejected');
  });
});

describe('anon write access to the other public info views', () => {
  // 20260718100000_narrow_remaining_anon_table_grants.sql: public_performer_info
  // and public_schedule_info were narrowed from GRANT ALL to SELECT-only for
  // anon, same as public_bookings_info above. Neither has a call site in
  // this repo (consumed by the separate performers-admin app), so this only
  // checks the write side - SELECT behavior for these two is exercised by
  // the separate app, not this test suite.
  test('anon cannot write to public_performer_info', async () => {
    const { error } = await anon.from('public_performer_info').update({ status: 'Paid' }).eq('id', scheduledPerformerId);
    assert.ok(error, 'expected anon UPDATE on public_performer_info to be rejected');
  });

  test('anon cannot write to public_schedule_info', async () => {
    const { error } = await anon.from('public_schedule_info').delete().eq('id', '00000000-0000-0000-0000-000000000000');
    assert.ok(error, 'expected anon DELETE on public_schedule_info to be rejected');
  });
});

describe('anon access to booking_locations', () => {
  // "Allow public anon to read confirmed booking locations" checks
  // bookings.status via the is_booking_confirmed() SECURITY DEFINER helper
  // (added in the same migration as the view above) rather than a direct
  // cross-table subquery, specifically so this keeps working now that anon
  // has zero RLS-permitted rows on bookings itself.
  test('a Confirmed booking\'s location assignment is visible to anon', async () => {
    const { data, error } = await anon.from('booking_locations').select('location_id').eq('booking_id', confirmedBookingId);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 1);
    assert.equal(data[0].location_id, liveLocationId);
  });

  test('a non-Confirmed booking has no visible location assignment to anon', async () => {
    const { data, error } = await anon.from('booking_locations').select('location_id').eq('booking_id', pendingBookingId);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 0);
  });

  // 20260718100000_narrow_remaining_anon_table_grants.sql: narrowed from
  // GRANT ALL to SELECT-only for anon.
  test('anon cannot write to booking_locations', async () => {
    const { error } = await anon.from('booking_locations').insert({ booking_id: confirmedBookingId, location_id: liveLocationId });
    assert.ok(error, 'expected anon INSERT on booking_locations to be rejected outright');
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

  // 2026-07-16 permission-audit fix: "Public can view scheduled" (TO
  // authenticated, anon) had no deleted_at check, while a separate anon-only
  // policy did - but RLS policies are OR'd, so the first policy's gap fully
  // neutralized the second's restriction. A soft-deleted Scheduled performer
  // (deleted_at is owned by the separate ellafestperformersadmin.vercel.app
  // app, not this repo) stayed publicly visible regardless. Fixed by folding
  // the deleted_at check into the one policy that actually matters.
  test('a soft-deleted Scheduled performer is not visible to anon', async () => {
    const { data, error } = await anon
      .from('performers')
      .select('id, name, description, performance_type, performance_type_other, status')
      .eq('id', deletedScheduledPerformerId);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 0, 'expected RLS to hide a soft-deleted performer from anon even though status is Scheduled');
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

  // 20260718100000_narrow_remaining_anon_table_grants.sql: locations was
  // narrowed from GRANT ALL to SELECT-only for anon (RLS was already the
  // only thing filtering rows; this makes the table grant a second,
  // independent layer). SELECT continuing to work is proven above; this
  // proves the write side is actually rejected outright, not just filtered.
  test('anon cannot write to locations', async () => {
    const { error: updateErr } = await anon.from('locations').update({ lat: 0 }).eq('id', liveLocationId);
    assert.ok(updateErr, 'expected anon UPDATE on locations to be rejected outright');

    const { error: insertErr } = await anon.from('locations').insert({ id: 'TESTSEC-INJECT', dataset: 'LIVE', lat: 0, lng: 0 });
    assert.ok(insertErr, 'expected anon INSERT on locations to be rejected outright');
  });
});

describe('anon access to location_power', () => {
  // Same narrowing as locations, applied the same day. No client call site
  // in this repo currently reads location_power, but its own RLS policy
  // ("Public view power") has always been SELECT-only, so the table grant
  // now just matches what was already the intent.
  test('anon can select but not write to location_power', async () => {
    const { error: selectErr } = await anon.from('location_power').select('*').limit(1);
    assert.equal(selectErr, null, selectErr?.message);

    const { error: updateErr } = await anon.from('location_power').update({ power_available: false }).eq('location', liveLocationId);
    assert.ok(updateErr, 'expected anon UPDATE on location_power to be rejected outright');
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

  // 20260718100000_narrow_remaining_anon_table_grants.sql: audit_logs,
  // email_templates, and hcc_checks all had GRANT ALL for anon with no RLS
  // policy that ever let anon through (audit_logs/hcc_checks are admin-only;
  // email_templates is authenticated-admin-only) - narrowed to zero,
  // same posture as user_roles/email_queue above.
  test('audit_logs is completely inaccessible to anon', async () => {
    const { error } = await anon.from('audit_logs').select('*');
    assert.ok(error, 'expected anon SELECT on audit_logs to be rejected outright');
  });

  test('email_templates is completely inaccessible to anon', async () => {
    const { error } = await anon.from('email_templates').select('*');
    assert.ok(error, 'expected anon SELECT on email_templates to be rejected outright');
  });

  test('hcc_checks is completely inaccessible to anon', async () => {
    const { error } = await anon.from('hcc_checks').select('*');
    assert.ok(error, 'expected anon SELECT on hcc_checks to be rejected outright');
  });

  test('payments is completely inaccessible to anon, including writes', async () => {
    // 20260718090000_narrow_payments_table_grants_anon.sql: payments used to
    // hold GRANT ALL for anon at the table level, with only the "Admin only
    // payments" RLS policy (implicitly PUBLIC, gated on check_user_role
    // ('admin')) stopping anon from reading/writing it - a single point of
    // failure. anon now has zero table-level grant, same posture as
    // user_roles/email_queue above, so every operation is rejected outright
    // rather than filtered down to zero rows.
    const { error: selectErr } = await anon.from('payments').select('*');
    assert.ok(selectErr, 'expected anon SELECT on payments to be rejected outright');

    const { error: insertErr } = await anon.from('payments').insert({
      booking_id: 'ESF26-TESTSEC-NOPE', paid: true, editor: 'anon-injection-attempt',
    });
    assert.ok(insertErr, 'expected anon INSERT on payments to be rejected outright');

    const { error: updateErr } = await anon
      .from('payments')
      .update({ paid: true })
      .eq('booking_id', 'ESF26-TESTSEC-NOPE');
    assert.ok(updateErr, 'expected anon UPDATE on payments to be rejected outright');

    const { error: deleteErr } = await anon.from('payments').delete().eq('booking_id', 'ESF26-TESTSEC-NOPE');
    assert.ok(deleteErr, 'expected anon DELETE on payments to be rejected outright');
  });
});

describe('admin access to email_queue', () => {
  // email_queue.html (js/page-email-queue.js) is admin-only end-to-end: the
  // page itself gates on requireAuth('admin'), and this is what actually
  // backs that - the "Admin manage email" RLS policy. The anon-rejection
  // case above only proves the door is locked; this proves the key admins
  // are handed actually opens it.
  test('admin can read email_queue rows, including the error_message on a failed send', async () => {
    const { data, error } = await admin
      .from('email_queue')
      .select('recipient, status, error_message')
      .eq('recipient', emailQueueTestRecipient)
      .single();
    assert.equal(error, null, error?.message);
    assert.equal(data.status, 'Error');
    assert.equal(data.error_message, 'Sec test induced failure');
  });
});

describe('anon access to privileged RPCs', () => {
  test('anon cannot call claim_pending_emails', async () => {
    // claim_pending_emails() uses the same `REVOKE ALL ... FROM PUBLIC`
    // pattern as the Stripe RPCs did before
    // 20260715123703_fix_stripe_anon_authenticated_grants.sql - on this
    // project, ALTER DEFAULT PRIVILEGES grants new functions directly to
    // anon/authenticated at creation time, so a PUBLIC-only revoke doesn't
    // necessarily block anon. Verified live here rather than assumed from
    // the grant statements alone: anon gets a real
    // "permission denied for function" (42501), confirming this one was
    // never actually exposed, unlike the Stripe RPCs.
    const { data, error } = await anon.rpc('claim_pending_emails', { p_batch_size: 1 });
    assert.ok(error, 'expected anon RPC call to claim_pending_emails to be rejected outright');
    assert.equal(data, null);
  });
});

describe('authenticated table grant narrowing (20260718110000)', () => {
  // Every real write path was traced (grep of every .insert()/.update()/
  // .delete()/.upsert() call site in js/, plus confirming all nine Edge
  // Functions use SERVICE_ROLE_KEY exclusively) before narrowing
  // `authenticated`'s table grants. These prove the removed privileges are
  // actually rejected live, not just absent from the grant text - the same
  // "verify, don't infer" lesson as every other narrowing this project has
  // done.

  test('authenticated cannot INSERT into payments directly (all real inserts are SECURITY DEFINER RPCs)', async () => {
    const { error } = await admin.from('payments').insert({ booking_id: 'ESF26-TESTSEC-NOPE2', paid: false });
    assert.ok(error, 'expected authenticated INSERT on payments to be rejected outright');
  });

  test('authenticated CAN delete from payments (finalizeConfirmation\'s real free-booking cleanup path)', async () => {
    await service.from('payments').upsert({ booking_id: confirmedBookingId, paid: true }, { onConflict: 'booking_id' });
    const { error } = await admin.from('payments').delete().eq('booking_id', confirmedBookingId);
    assert.equal(error, null, error?.message);
    const { data } = await service.from('payments').select('booking_id').eq('booking_id', confirmedBookingId).maybeSingle();
    assert.equal(data, null, 'expected the authenticated DELETE to have actually removed the row');
  });

  test('authenticated cannot write to booking_locations directly (writes go through rpc_set_booking_locations)', async () => {
    const { error } = await admin.from('booking_locations').insert({ booking_id: confirmedBookingId, location_id: liveLocationId });
    assert.ok(error, 'expected authenticated INSERT on booking_locations to be rejected outright');
  });

  test('authenticated cannot write to locations directly (physical locations are seed/migration-only)', async () => {
    const { error } = await admin.from('locations').update({ lat: 0 }).eq('id', liveLocationId);
    assert.ok(error, 'expected authenticated UPDATE on locations to be rejected outright');
  });

  test('authenticated cannot write to location_power (zero real usage anywhere)', async () => {
    const { error } = await admin.from('location_power').update({ power_available: true }).eq('location', liveLocationId);
    assert.ok(error, 'expected authenticated UPDATE on location_power to be rejected outright');
  });

  test('authenticated cannot UPDATE or DELETE audit_logs (append-only log)', async () => {
    const { error: updateErr } = await admin.from('audit_logs').update({ action: 'tampered' }).eq('booking_id', confirmedBookingId);
    assert.ok(updateErr, 'expected authenticated UPDATE on audit_logs to be rejected outright');

    const { error: deleteErr } = await admin.from('audit_logs').delete().eq('booking_id', confirmedBookingId);
    assert.ok(deleteErr, 'expected authenticated DELETE on audit_logs to be rejected outright');
  });

  test('authenticated cannot INSERT or DELETE email_templates (edit-existing-only, no create/delete UI)', async () => {
    const { error: insertErr } = await admin.from('email_templates').insert({ id: 'sectest_template', subject: 's', body_html: 'b' });
    assert.ok(insertErr, 'expected authenticated INSERT on email_templates to be rejected outright');

    const { error: deleteErr } = await admin.from('email_templates').delete().eq('id', 'application_received');
    assert.ok(deleteErr, 'expected authenticated DELETE on email_templates to be rejected outright');
  });

  test('authenticated cannot UPDATE or DELETE email_queue directly (status transitions are RPC/service-role only)', async () => {
    const { error: updateErr } = await admin.from('email_queue').update({ status: 'Sent' }).eq('recipient', emailQueueTestRecipient);
    assert.ok(updateErr, 'expected authenticated UPDATE on email_queue to be rejected outright');

    const { error: deleteErr } = await admin.from('email_queue').delete().eq('recipient', emailQueueTestRecipient);
    assert.ok(deleteErr, 'expected authenticated DELETE on email_queue to be rejected outright');
  });

  test('authenticated cannot DELETE bookings (no hard-delete path exists anywhere)', async () => {
    const { error } = await admin.from('bookings').delete().eq('id', confirmedBookingId);
    assert.ok(error, 'expected authenticated DELETE on bookings to be rejected outright');
  });

  test('authenticated cannot write to the three public info views', async () => {
    const { error: bookingsViewErr } = await admin.from('public_bookings_info').update({ business_name: 'Hacked' }).eq('id', confirmedBookingId);
    assert.ok(bookingsViewErr, 'expected authenticated UPDATE on public_bookings_info to be rejected');

    const { error: performerViewErr } = await admin.from('public_performer_info').update({ status: 'Paid' }).eq('id', scheduledPerformerId);
    assert.ok(performerViewErr, 'expected authenticated UPDATE on public_performer_info to be rejected');

    const { error: scheduleViewErr } = await admin.from('public_schedule_info').delete().eq('id', '00000000-0000-0000-0000-000000000000');
    assert.ok(scheduleViewErr, 'expected authenticated DELETE on public_schedule_info to be rejected');
  });
});
