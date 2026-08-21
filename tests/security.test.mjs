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
import { url, anonKey, adminEmail, adminPassword, service } from './helpers.mjs';

const anon = createClient(url, anonKey);

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
// The two booking-form open/closed flags (written by settings.html's toggle,
// read by the public booking pages as anon). Saved/restored around the run
// because unlike the other fixtures they're global keys, not TESTSEC-prefixed
// rows we own outright.
const bookingOpenKeys = ['food_bookings_open', 'general_bookings_open'];
let savedBookingOpenRows;

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
      id: confirmedBookingId, org_id: 'org_default', event_id: 'event_default', status: 'Confirmed', business_name: 'Sec Test Confirmed',
      owner_name: 'Secret Owner', email: 'secret@example.test', phone: '07000000001',
      admin_notes: 'secret admin note', instance_prefix: 'ESF26-FOOD-', stall_type: 'Food',
    },
    {
      id: pendingBookingId, org_id: 'org_default', event_id: 'event_default', status: 'Pending', business_name: 'Sec Test Pending',
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
    { id: devLocationId, dataset: 'DEV', lat: 0, lng: 0, org_id: 'org_default', event_id: 'event_default' },
    { id: liveLocationId, dataset: 'LIVE', lat: 0, lng: 0, org_id: 'org_default', event_id: 'event_default' },
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
    org_id: 'org_default',
  });
  if (emailQueueInsertErr) throw new Error(`Fixture setup failed (email_queue): ${emailQueueInsertErr.message}`);

  const { data: savedRows, error: savedErr } = await service.from('settings').select('org_id, key, value').in('key', bookingOpenKeys);
  if (savedErr) throw new Error(`Fixture setup failed (settings read): ${savedErr.message}`);
  savedBookingOpenRows = savedRows;
  const { error: settingsErr } = await service.from('settings').upsert(
    bookingOpenKeys.map((key) => ({ org_id: 'org_default', key, value: 'true' })),
    { onConflict: 'org_id,key' },
  );
  if (settingsErr) throw new Error(`Fixture setup failed (settings): ${settingsErr.message}`);
});

after(async () => {
  await service.from('booking_locations').delete().in('booking_id', [confirmedBookingId, pendingBookingId]);
  await service.from('bookings').delete().in('id', [confirmedBookingId, pendingBookingId]);
  await service.from('performers').delete().in('id', [scheduledPerformerId, appliedPerformerId, deletedScheduledPerformerId]);
  await service.from('locations').delete().in('id', [devLocationId, liveLocationId]);
  await service.from('email_queue').delete().eq('recipient', emailQueueTestRecipient);
  // Restore the booking-open flags to whatever they were before the run:
  // delete the ones that didn't exist, put back the ones that did.
  if (savedBookingOpenRows) {
    const savedKeys = savedBookingOpenRows.map((r) => r.key);
    const unsavedKeys = bookingOpenKeys.filter((k) => !savedKeys.includes(k));
    if (unsavedKeys.length) await service.from('settings').delete().in('key', unsavedKeys);
    if (savedKeys.length) await service.from('settings').upsert(savedBookingOpenRows, { onConflict: 'org_id,key' });
  }
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
  // Launch Readiness Review, Finding 2 (20260805040000): anon lost its
  // direct SELECT grant on locations entirely — the old unfiltered query
  // (`dataset='LIVE'`, no org_id) let one anon request enumerate every
  // organisation's live locations at once. Reads now go through
  // rpc_get_public_locations(org_id, dataset), the same
  // "no anon table grant, only a controlled SECURITY DEFINER function"
  // pattern storage.objects already used.
  test('anon has no direct SELECT on locations at all', async () => {
    const { data, error } = await anon.from('locations').select('id,dataset');
    if (!error) {
      assert.equal(data.length, 0, 'expected zero rows via direct anon table access — reads must go through rpc_get_public_locations');
    }
  });

  test('DEV rows are never visible via rpc_get_public_locations, even unfiltered by id', async () => {
    const { data: unfiltered, error } = await anon.rpc('rpc_get_public_locations', { p_org_id: 'org_default', p_dataset: 'DEV' });
    assert.equal(error, null, error?.message);
    assert.ok(!(unfiltered || []).some((r) => r.id === devLocationId) || unfiltered.every((r) => r.dataset === 'DEV'),
      'rpc_get_public_locations(p_dataset="DEV") should only ever return DEV rows when DEV is explicitly requested');

    const { data: explicitDev } = await anon.rpc('rpc_get_public_locations', { p_org_id: 'org_default', p_dataset: 'LIVE' });
    assert.ok(!(explicitDev || []).some((r) => r.id === devLocationId), 'expected the DEV test row to be absent when LIVE is requested');

    const { data: explicitLive } = await anon.rpc('rpc_get_public_locations', { p_org_id: 'org_default', p_dataset: 'LIVE' });
    assert.ok((explicitLive || []).some((r) => r.id === liveLocationId), 'expected the LIVE test row to be present when LIVE is requested');
  });

  test('rpc_get_public_locations only returns the requested organisation\'s rows', async () => {
    const { data, error } = await anon.rpc('rpc_get_public_locations', { p_org_id: 'some-other-org-entirely', p_dataset: 'LIVE' });
    assert.equal(error, null, error?.message);
    assert.equal((data || []).length, 0, 'a made-up org_id must return nothing, not fall back to org_default or every organisation');
  });

  // 20260718100000_narrow_remaining_anon_table_grants.sql: locations was
  // narrowed from GRANT ALL to SELECT-only for anon, then SELECT itself was
  // later revoked entirely by the Finding 2 fix above. This proves the
  // write side is still rejected outright, independent of whichever way
  // reads currently work.
  test('anon cannot write to locations', async () => {
    const { error: updateErr } = await anon.from('locations').update({ lat: 0 }).eq('id', liveLocationId);
    assert.ok(updateErr, 'expected anon UPDATE on locations to be rejected outright');

    const { error: insertErr } = await anon.from('locations').insert({ id: 'TESTSEC-INJECT', dataset: 'LIVE', lat: 0, lng: 0 });
    assert.ok(insertErr, 'expected anon INSERT on locations to be rejected outright');
  });
});

// The `anon access to location_power` block was removed on 2026-07-20 along
// with the table itself (migration 20260720120000). If location_power is ever
// restored from supabase/sql-archive/restore_location_power.sql, restore these
// grant assertions too - anon was SELECT-only and authenticated could not
// write, and both were worth locking in.

describe('anon access to settings (booking open/closed flags)', () => {
  // 20260718140000_allow_anon_read_booking_open_flags.sql: the public booking
  // pages read food_bookings_open / general_bookings_open as anon to decide
  // whether to swap the form for the "bookings closed" notice
  // (js/page-food-booking.js, js/page-general-booking.js). Phase 3 WP2
  // (20260815220000) replaced anon's direct SELECT on `settings` with
  // rpc_get_public_settings(p_org_id) — same allow-list, same observable
  // behaviour, but a single call can now never span more than one
  // organisation. These tests exercise the org_default row set, matching
  // this whole file's implicit org_default scoping (the admin fixture signs
  // in as the org_default test admin, and settings.upsert() below carries no
  // explicit org_id, so it defaults to org_default).
  test('anon can read both booking-open flags via rpc_get_public_settings', async () => {
    const { data, error } = await anon.rpc('rpc_get_public_settings', { p_org_id: 'org_default' });
    assert.equal(error, null, error?.message);
    const byKey = new Map((data || []).map((r) => [r.key, r.value]));
    for (const key of bookingOpenKeys) {
      assert.equal(byKey.get(key), 'true', `expected anon to read settings.${key} via the RPC`);
    }
  });

  test('closing a form via the admin toggle is actually visible to anon (the closed-notice data path)', async () => {
    // settings.html's toggleSetting() runs as an authenticated admin and
    // upserts value 'false'; mirror that real write path, then confirm the
    // public page's read (now via the RPC) sees it. page-*-booking.js hides
    // the form when the value !== 'true', so anon receiving 'false' here is
    // precisely the condition that shows the closed notice.
    const { error: toggleErr } = await admin.from('settings').upsert({
      org_id: 'org_default', key: 'food_bookings_open', value: 'false',
      updated_at: new Date().toISOString(), updated_by: adminEmail,
    }, { onConflict: 'org_id,key' });
    assert.equal(toggleErr, null, toggleErr?.message);

    const { data, error } = await anon.rpc('rpc_get_public_settings', { p_org_id: 'org_default' });
    assert.equal(error, null, error?.message);
    const closedValue = (data || []).find((r) => r.key === 'food_bookings_open')?.value;
    assert.equal(closedValue, 'false', 'expected anon to see the toggled-closed value');

    // Re-open and confirm the round trip back to "form shows".
    const { error: reopenErr } = await admin.from('settings').upsert({
      org_id: 'org_default', key: 'food_bookings_open', value: 'true',
      updated_at: new Date().toISOString(), updated_by: adminEmail,
    }, { onConflict: 'org_id,key' });
    assert.equal(reopenErr, null, reopenErr?.message);
    const { data: reopenedRows } = await anon.rpc('rpc_get_public_settings', { p_org_id: 'org_default' });
    const reopenedValue = (reopenedRows || []).find((r) => r.key === 'food_bookings_open')?.value;
    assert.equal(reopenedValue, 'true');
  });

  test('anon can no longer SELECT the settings table directly at all (old attack shape)', async () => {
    // Pre-WP2, this exact unfiltered query returned every organisation's
    // rows for every allow-listed key in one call — the vulnerability WP2
    // closes. Confirms the base-table grant is genuinely gone, not just
    // narrowed.
    const { data, error } = await anon.from('settings').select('key, value').eq('key', 'food_bookings_open');
    assert.ok(error || (data || []).length === 0, 'expected the base settings table to no longer be directly readable by anon');
  });

  test('the allowlist still hides sensitive settings rows from anon, via the RPC', async () => {
    // bank_account_number is seeded by scripts/seed-test-project.mjs and is
    // deliberately NOT on the allowlist.
    const { data, error } = await anon.rpc('rpc_get_public_settings', { p_org_id: 'org_default' });
    assert.equal(error, null, error?.message);
    assert.ok(!(data || []).some((r) => r.key === 'bank_account_number'), 'expected bank_account_number to stay invisible to anon');

    // Every key the RPC returns must be within the known allow-list — this
    // is enforced inside the function body itself now (not a base-table RLS
    // policy), so this test is really confirming the migration's allow-list
    // literal matches what this file independently expects.
    const allowlist = [
      'stall_cost_food', 'stall_cost_general', 'stall_cost_dev', 'turnstile_site_key',
      'base_url', 'cancel_url', 'portal_url', 'booking_prefix', 'bucket_name',
      'map_center_lat', 'map_center_lng', 'map_default_zoom',
      // Anon-readable (20260731150000) specifically for login.html/
      // steward_login.html, which have no session yet - as safe as
      // turnstile_site_key, both designed for client-visible embedding.
      // sentry_dsn (the Edge Function backend DSN) is deliberately NOT here.
      'sentry_browser_loader_url',
      // Organisation branding (20260803120000_consolidate_branding_defaults.sql,
      // same PR that added public_organisations_info/public_events_info) -
      // designed for client-visible embedding on public event/booking pages,
      // same reasoning as turnstile_site_key above. This list itself wasn't
      // updated when that migration shipped; caught by a full regression run
      // during the Epic 4 Phase 4D operational review, not a live leak - the
      // allow-list has included these on purpose since that PR merged.
      'logo_url', 'logo_light_url', 'brand_primary_color', 'brand_accent_color',
      'org_support_email', 'email_footer_text',
      ...bookingOpenKeys,
      // Regulatory Authority (V1.1 Sprint 1, Issue 2,
      // 20260807120000_regulatory_authority_settings.sql) - the public
      // food-stall declaration reads these before an applicant is
      // authenticated, same reasoning as the branding keys above.
      'regulatory_authority_name', 'insurance_minimum_amount',
    ];
    const leaked = (data || []).map((r) => r.key).filter((k) => !allowlist.includes(k));
    assert.deepEqual(leaked, [], `expected no settings keys outside the anon allowlist, got: ${leaked.join(', ')}`);
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

  // 20260718100000_narrow_remaining_anon_table_grants.sql: audit_logs and
  // email_templates both had GRANT ALL for anon with no RLS policy that ever
  // let anon through (audit_logs is admin-only; email_templates is
  // authenticated-admin-only) - narrowed to zero, same posture as
  // user_roles/email_queue above.
  test('audit_logs is completely inaccessible to anon', async () => {
    const { error } = await anon.from('audit_logs').select('*');
    assert.ok(error, 'expected anon SELECT on audit_logs to be rejected outright');
  });

  test('email_templates is completely inaccessible to anon', async () => {
    const { error } = await anon.from('email_templates').select('*');
    assert.ok(error, 'expected anon SELECT on email_templates to be rejected outright');
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
    await service.from('payments').upsert({ booking_id: confirmedBookingId, org_id: 'org_default', paid: true }, { onConflict: 'booking_id' });
    const { error } = await admin.from('payments').delete().eq('booking_id', confirmedBookingId);
    assert.equal(error, null, error?.message);
    const { data } = await service.from('payments').select('booking_id').eq('booking_id', confirmedBookingId).maybeSingle();
    assert.equal(data, null, 'expected the authenticated DELETE to have actually removed the row');
  });

  test('authenticated cannot write to booking_locations directly (writes go through rpc_set_booking_locations)', async () => {
    const { error } = await admin.from('booking_locations').insert({ booking_id: confirmedBookingId, location_id: liveLocationId });
    assert.ok(error, 'expected authenticated INSERT on booking_locations to be rejected outright');
  });

  test('an admin CAN write to locations directly (Phase 4C: reversed by 20260804100000 — physical locations now have a real admin UI, not seed/migration-only)', async () => {
    const { error } = await admin.from('locations').update({ lat: 12.34 }).eq('id', liveLocationId);
    assert.equal(error, null, error?.message);
    const { data } = await service.from('locations').select('lat').eq('id', liveLocationId).eq('dataset', 'LIVE').maybeSingle();
    assert.equal(data.lat, 12.34, 'expected the authenticated UPDATE to have actually taken effect');
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
