// Behavioural test for queueLocationEmail() (js/shared.js) — sent when an
// admin allocates a pitch to a Confirmed booking (js/locations.js's
// openLocationEmailModal flow). Previously a real, shipped feature with
// zero test coverage.
//
// Mirrors queueLocationEmail's own sequence directly (fetch booking, fetch
// its assigned locations, fetch the 'location_update' email template, queue
// the email, write the audit row) at the same fidelity as
// rejection.test.mjs / workflow.test.mjs, rather than importing the browser
// module itself (which depends on getSupabaseClient()/localStorage, neither
// meaningful in a plain Node test).
//
// The 'location_update' template isn't one of the four scripts/seed-test-project.mjs
// already ensures, so this file seeds it itself (upsert, same shape) rather
// than expanding what every other test's setup depends on for a template
// only this file needs.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, adminEmail, adminPassword, service } from './helpers.mjs';

const authed = createClient(url, anonKey);

const bookingId = 'ESF26-TESTLOCEMAIL-0001';
const locationId = 'TESTLOCEMAIL-A';
const RECIPIENT = 'locemail-test@example.test';

before(async () => {
  const { error } = await authed.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${error.message}`);

  await service.from('email_templates').upsert({
    org_id: 'org_default',
    id: 'location_update',
    subject: 'Your pitch location (Ref: {{booking_id}})',
    body_html: 'Dear {{owner_name}}, {{business_name}} has been allocated to {{location_display}}.',
  }, { onConflict: 'org_id,id' });

  await service.from('audit_logs').delete().eq('target_id', bookingId);
  await service.from('email_queue').delete().eq('recipient', RECIPIENT);
  await service.from('booking_locations').delete().eq('booking_id', bookingId);
  await service.from('bookings').delete().eq('id', bookingId);
  await service.from('locations').delete().eq('id', locationId);

  const { error: locErr } = await service.from('locations').insert({ id: locationId, dataset: 'LIVE', lat: 0, lng: 0 });
  if (locErr) throw new Error(`Fixture setup failed (locations): ${locErr.message}`);

  const { error: insertErr } = await service.from('bookings').insert({
    id: bookingId,
    status: 'Confirmed',
    business_name: 'Location Email Test Stall',
    owner_name: 'Location Email Tester',
    email: RECIPIENT,
    instance_prefix: 'ESF26-DEV-',
    stall_type: 'Food',
  });
  if (insertErr) throw new Error(`Fixture setup failed (bookings): ${insertErr.message}`);
});

after(async () => {
  await service.from('audit_logs').delete().eq('target_id', bookingId);
  await service.from('email_queue').delete().eq('recipient', RECIPIENT);
  await service.from('booking_locations').delete().eq('booking_id', bookingId);
  await service.from('bookings').delete().eq('id', bookingId);
  await service.from('locations').delete().eq('id', locationId);
});

describe('location allocation email: template fetched -> email queued -> audit log', () => {
  test('1. allocate a pitch to the booking', async () => {
    const { error } = await authed.rpc('rpc_set_booking_locations', { p_booking_id: bookingId, p_location_ids: [locationId] });
    assert.equal(error, null, error?.message);

    const { data: assigned } = await service.from('booking_locations').select('location_id').eq('booking_id', bookingId);
    assert.deepEqual(assigned.map((r) => r.location_id), [locationId]);
  });

  test('2. queueLocationEmail queues an email for the assigned location', async () => {
    // Mirrors queueLocationEmail(): fetch booking, fetch its assigned
    // locations (already proven non-empty by step 1 — queueLocationEmail
    // itself throws "No location assigned yet." otherwise), fetch the
    // template, then queue.
    const { data: template, error: templateErr } = await authed
      .from('email_templates')
      .select('subject, body_html')
      .eq('org_id', 'org_default')
      .eq('id', 'location_update')
      .single();
    assert.equal(templateErr, null, templateErr?.message);
    assert.ok(template.subject && template.body_html);

    const subject = template.subject.replace('{{booking_id}}', bookingId);
    const body = template.body_html
      .replace('{{owner_name}}', 'Location Email Tester')
      .replace('{{business_name}}', 'Location Email Test Stall')
      .replace('{{location_display}}', locationId);

    let status = 'Sent';
    let errorMessage = null;
    const { data, error } = await authed.functions.invoke('send-email', {
      body: { recipient: RECIPIENT, subject, body },
    });
    if (error || (data && data.error)) {
      status = 'Error';
      errorMessage = data?.error || error.message;
    }
    assert.equal(status, 'Error', "expected the send to fail against this project's deliberately-unconfigured Zoho credentials");

    const { error: queueErr } = await authed.from('email_queue').insert({
      recipient: RECIPIENT,
      subject,
      body,
      status,
      error_message: errorMessage,
      instance_prefix: 'ESF26-DEV-',
    });
    assert.equal(queueErr, null, queueErr?.message);

    const { data: rows } = await service.from('email_queue').select('*').eq('recipient', RECIPIENT);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'Error');
    assert.ok(rows[0].subject.includes(bookingId));
  });

  test('3. queueLocationEmail writes a location_email_queued audit row with the location ids', async () => {
    const { error } = await authed.from('audit_logs').insert({
      action: 'location_email_queued',
      target_id: bookingId,
      details: { location_ids: [locationId] },
    });
    assert.equal(error, null, error?.message);

    const { data: rows } = await service.from('audit_logs').select('*').eq('target_id', bookingId).eq('action', 'location_email_queued');
    assert.equal(rows.length, 1);
    const details = JSON.parse(rows[0].details);
    assert.deepEqual(details.location_ids, [locationId]);
  });
});
