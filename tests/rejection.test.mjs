// Behavioural test for the booking rejection workflow — previously
// completely untested despite being at least as common an admin action as a
// refund. Mirrors js/kanban.js's updateStatus() -> js/shared.js's
// sharedUpdateStatus() 'Rejected' branch -> js/api.js's updateBookingStatus()
// + sendEmail(): the same direct table/RPC/Edge-Function calls the frontend
// itself makes, at the same fidelity as workflow.test.mjs's confirm/pay/
// HCC/cancel chain, rather than reasoning about the code from a distance.
//
// The email step deliberately calls the real send-email Edge Function (see
// HANDOVER.md's Edge Function table: admin-JWT-callable, the only function
// that actually talks to Zoho) rather than just inserting the email_queue
// row that would result — this project's test Zoho credentials are
// deliberately unconfigured, so the call genuinely fails, and the resulting
// email_queue row records that real failure. Same "no real email is ever
// possible, and the failure IS the assertion mechanism" principle already
// used by email-retry.test.mjs / integration.test.mjs, not a new pattern.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, adminEmail, adminPassword, service } from './helpers.mjs';

const authed = createClient(url, anonKey);

const bookingId = 'ESF26-TESTREJECT-0001';
const RECIPIENT = 'reject-test@example.test';
const REJECTION_REASON = 'Incomplete public liability insurance documentation';

before(async () => {
  const { error } = await authed.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${error.message}`);

  await service.from('audit_logs').delete().eq('target_id', bookingId);
  await service.from('email_queue').delete().eq('recipient', RECIPIENT);
  await service.from('bookings').delete().eq('id', bookingId);

  const { error: insertErr } = await service.from('bookings').insert({
    id: bookingId,
    status: 'Pending',
    business_name: 'Rejection Test Stall',
    owner_name: 'Rejection Tester',
    email: RECIPIENT,
    instance_prefix: 'ESF26-DEV-',
    stall_type: 'Food',
  });
  if (insertErr) throw new Error(`Fixture setup failed: ${insertErr.message}`);
});

after(async () => {
  await service.from('audit_logs').delete().eq('target_id', bookingId);
  await service.from('email_queue').delete().eq('recipient', RECIPIENT);
  await service.from('bookings').delete().eq('id', bookingId);
});

describe('booking rejection: status -> reason stored -> email queued -> audit log', () => {
  test('1. reject a Pending booking, storing the reason', async () => {
    const { error } = await authed
      .from('bookings')
      .update({ status: 'Rejected', rejection_reason: REJECTION_REASON })
      .eq('id', bookingId);
    assert.equal(error, null, error?.message);

    const { data: booking } = await service.from('bookings').select('status, rejection_reason').eq('id', bookingId).single();
    assert.equal(booking.status, 'Rejected');
    assert.equal(booking.rejection_reason, REJECTION_REASON);
  });

  test('2. rejection queues a rejection email', async () => {
    const subject = 'Your Ella Street Festival application';
    const body = `Unfortunately your application was not successful. Reason: ${REJECTION_REASON}`;

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
    assert.ok(rows[0].error_message, 'expected an error_message describing why the send failed');
  });

  test('3. rejection writes an audit log row', async () => {
    const { error } = await authed.from('audit_logs').insert({
      action: 'update_status',
      target_id: bookingId,
      details: { new_status: 'Rejected', reason: REJECTION_REASON },
    });
    assert.equal(error, null, error?.message);

    const { data: rows } = await service.from('audit_logs').select('*').eq('target_id', bookingId).eq('action', 'update_status');
    assert.equal(rows.length, 1);
    // details is stored as TEXT, not JSONB (same as stripe-payment.test.mjs's own read).
    const details = JSON.parse(rows[0].details);
    assert.equal(details.new_status, 'Rejected');
    assert.equal(details.reason, REJECTION_REASON);
  });
});
