// Manual bank-transfer payment tests, alongside the existing Stripe flow
// (tests/stripe-payment.test.mjs) - see that file for the same guard.
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

// Own prefix so this file's cleanup wildcard can never collide with the
// other test files sharing one remote database (--test-concurrency=1 keeps
// files from running at the same time, but each still needs its own
// distinct prefix for its own before/after wildcard deletes to be safe).
const PREFIX = 'ESF26-TESTBANKTRANSFER-';

let adminUserId;

async function callFunction(name, body, token = anonKey) {
  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function insertBooking(id, overrides = {}) {
  const { error } = await service.from('bookings').insert({
    id,
    status: 'Pending',
    business_name: `Bank Transfer Test ${id}`,
    owner_name: 'Test Owner',
    email: 'bank-transfer-test@example.test',
    instance_prefix: 'ESF26-DEV-',
    stall_type: 'Food',
    ...overrides,
  });
  if (error) throw new Error(`Fixture setup failed for ${id}: ${error.message}`);
}

before(async () => {
  const { data, error } = await anon.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${error.message}`);
  adminUserId = data.user.id;

  await service.from('bookings').delete().like('id', `${PREFIX}%`);
});

after(async () => {
  await service.from('bookings').delete().like('id', `${PREFIX}%`);
  // Defensive — the steward-rejection test restores this itself in a
  // finally block, but guarantee it here too in case that test ever fails
  // mid-way, so it can never leak a demoted test admin into another file.
  await service.from('user_roles').update({ role: 'admin' }).eq('id', adminUserId);
});

describe('rpc_record_bank_transfer_payment', () => {
  test('anon cannot call it directly', async () => {
    // The shared `anon` client is already signed in as the test admin by
    // this point (see before()) — use a genuinely fresh, unauthenticated
    // client so this actually tests an anon call, not an admin one.
    const freshAnon = createClient(url, anonKey);
    const { error } = await freshAnon.rpc('rpc_record_bank_transfer_payment', {
      p_booking_id: 'x', p_payment_reference: 'x', p_notes: null
    });
    assert.ok(error, 'expected anon to be rejected calling rpc_record_bank_transfer_payment');
  });

  test('a non-admin authenticated user (steward) cannot call it', async () => {
    const id = `${PREFIX}STEWARD`;
    await insertBooking(id, { status: 'Payment Requested', stall_cost: 10 });

    // Temporarily demote the test admin to steward to exercise the "not
    // admin" rejection path with a genuinely authenticated (just
    // non-admin) session, then restore — no separate steward test user
    // exists anywhere in this test suite, and adding one purely for this
    // one assertion isn't worth the extra fixture surface.
    const { error: demoteErr } = await service.from('user_roles').update({ role: 'steward' }).eq('id', adminUserId);
    assert.equal(demoteErr, null, demoteErr?.message);

    try {
      const { error } = await anon.rpc('rpc_record_bank_transfer_payment', {
        p_booking_id: id, p_payment_reference: id, p_notes: null
      });
      assert.ok(error, 'expected a steward-role session to be rejected');

      const { data: booking } = await service.from('bookings').select('status').eq('id', id).single();
      assert.equal(booking.status, 'Payment Requested', 'status must be untouched by the rejected call');
    } finally {
      await service.from('user_roles').update({ role: 'admin' }).eq('id', adminUserId);
    }
  });

  test('happy path: records payment, verifies it, and auto-confirms the booking atomically', async () => {
    const id = `${PREFIX}HAPPY`;
    await insertBooking(id, { status: 'Payment Requested', stall_cost: 30 });

    const { error: rpcErr } = await anon.rpc('rpc_record_bank_transfer_payment', {
      p_booking_id: id,
      p_payment_reference: id,
      p_notes: 'Received via online banking, ref matched.',
    });
    assert.equal(rpcErr, null, rpcErr?.message);

    const { data: booking } = await service.from('bookings').select('status, date_confirmed').eq('id', id).single();
    assert.equal(booking.status, 'Confirmed');
    assert.ok(booking.date_confirmed);

    const { data: payment } = await service.from('payments').select('*').eq('booking_id', id).single();
    assert.equal(payment.paid, true);
    assert.equal(payment.payment_method, 'bank_transfer');
    assert.equal(payment.payment_reference, id);
    assert.equal(payment.verified_by, adminEmail);
    assert.ok(payment.verified_at);
    assert.equal(payment.notes, 'Received via online banking, ref matched.');
    assert.ok(payment.bank_ref.includes(id));
  });

  test('the payment reference is editable — need not match the booking id exactly', async () => {
    const id = `${PREFIX}CUSTOMREF`;
    await insertBooking(id, { status: 'Payment Requested', stall_cost: 15 });

    const { error } = await anon.rpc('rpc_record_bank_transfer_payment', {
      p_booking_id: id,
      p_payment_reference: 'CUSTOMER-STATED-REF-123',
      p_notes: null,
    });
    assert.equal(error, null, error?.message);

    const { data: payment } = await service.from('payments').select('payment_reference').eq('booking_id', id).single();
    assert.equal(payment.payment_reference, 'CUSTOMER-STATED-REF-123');
  });

  test('rejects a booking that is not currently Payment Requested', async () => {
    const id = `${PREFIX}NOTAWAITING`;
    await insertBooking(id, { status: 'Pending' });

    const { error } = await anon.rpc('rpc_record_bank_transfer_payment', {
      p_booking_id: id, p_payment_reference: id, p_notes: null
    });
    assert.ok(error, 'expected rejection for a booking not in Payment Requested');

    const { data: booking } = await service.from('bookings').select('status').eq('id', id).single();
    assert.equal(booking.status, 'Pending', 'status must be untouched');

    const { data: payment } = await service.from('payments').select('booking_id').eq('booking_id', id).maybeSingle();
    assert.equal(payment, null, 'no payments row should have been created');
  });

  test('rejects an empty payment reference', async () => {
    const id = `${PREFIX}EMPTYREF`;
    await insertBooking(id, { status: 'Payment Requested', stall_cost: 10 });

    const { error } = await anon.rpc('rpc_record_bank_transfer_payment', {
      p_booking_id: id, p_payment_reference: '   ', p_notes: null
    });
    assert.ok(error, 'expected rejection for a blank payment reference');

    const { data: booking } = await service.from('bookings').select('status').eq('id', id).single();
    assert.equal(booking.status, 'Payment Requested', 'status must be untouched');
  });
});

describe('payment_requested email includes bank-transfer instructions', () => {
  test('sent email contains both the Stripe link and bank-transfer details + required wording', async () => {
    const id = `${PREFIX}EMAILCONTENT`;
    await insertBooking(id, { status: 'Pending', stall_cost: 12 });

    // Re-uses the same TEST_ADMIN_EMAIL/PASSWORD sign-in used throughout
    // this suite for the admin bearer token create-checkout-session needs.
    const { data: signIn } = await anon.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
    const adminToken = signIn.session.access_token;

    const { status, json } = await callFunction('create-checkout-session', { booking_id: id }, adminToken);
    assert.equal(status, 200, JSON.stringify(json));

    const { data: emailRow } = await service
      .from('email_queue')
      .select('body')
      .eq('recipient', 'bank-transfer-test@example.test')
      .order('id', { ascending: false })
      .limit(1)
      .single();

    assert.ok(emailRow, 'expected a queued email for this booking');
    const body = emailRow.body;

    assert.ok(body.includes(json.checkout_url), 'expected the real Stripe checkout URL in the email body');
    assert.ok(body.includes(id), 'expected the booking id (used as the bank-transfer payment reference) in the email body');
    assert.ok(
      body.includes('Your booking will not be confirmed until payment has been received and verified by an administrator.'),
      'expected the exact required wording in the email body'
    );

    // Bank-detail values come from the settings seeded by
    // scripts/seed-test-project.mjs's ensureSettings() — asserting the
    // literal seeded values proves they were actually substituted, not
    // just that the placeholder text survived unreplaced.
    const { data: settingsRows } = await service.from('settings').select('key, value').in('key', ['bank_account_name', 'bank_sort_code', 'bank_account_number']);
    const settingsMap = Object.fromEntries((settingsRows || []).map((r) => [r.key, r.value]));
    for (const key of ['bank_account_name', 'bank_sort_code', 'bank_account_number']) {
      assert.ok(settingsMap[key], `expected ${key} to be seeded in settings (run scripts/seed-test-project.mjs)`);
      assert.ok(body.includes(settingsMap[key]), `expected the seeded ${key} value ("${settingsMap[key]}") in the email body`);
    }
  });
});

describe('Stripe workflow unaffected', () => {
  test('finalize_stripe_payment still works and now also stamps payment_method=stripe', async () => {
    const id = `${PREFIX}STRIPEUNAFFECTED`;
    await insertBooking(id, { status: 'Payment Requested', stall_cost: 18 });

    const { error } = await service.rpc('finalize_stripe_payment', {
      p_booking_id: id,
      p_payment_intent_id: 'pi_test_bank_transfer_regression_check',
    });
    assert.equal(error, null, error?.message);

    const { data: booking } = await service.from('bookings').select('status').eq('id', id).single();
    assert.equal(booking.status, 'Confirmed');

    const { data: payment } = await service.from('payments').select('*').eq('booking_id', id).single();
    assert.equal(payment.paid, true);
    assert.equal(payment.editor, 'Stripe (automatic)');
    assert.equal(payment.payment_method, 'stripe');
  });
});

describe('audit trail for bank-transfer actions', () => {
  // This test suite runs in Node and never imports js/api.js (no existing
  // test file in this repo does) — so it can't observe the browser-side
  // recordBankTransferPayment() function's exact call sequence directly.
  // What it can and does prove: the same admin-authenticated client that
  // function runs on top of can actually write the three required audit
  // rows with the exact action/detail shapes it sends, and that anon
  // cannot. A true end-to-end check of the browser function itself would
  // need a browser-level test, which doesn't exist anywhere in this suite.
  test('an authenticated admin can write the three required audit rows', async () => {
    const id = `${PREFIX}AUDITTRAIL`;
    const reference = id;

    await service.from('audit_logs').delete().eq('target_id', id);

    const rows = [
      { action: 'bank_transfer_recorded', target_id: id, details: { payment_reference: reference, notes: null } },
      { action: 'bank_transfer_verified', target_id: id, details: { payment_reference: reference } },
      { action: 'booking_auto_confirmed_bank_transfer', target_id: id, details: { payment_reference: reference } },
    ];

    for (const row of rows) {
      const { error } = await anon.from('audit_logs').insert({
        action: row.action,
        target_id: row.target_id,
        user_email: adminEmail,
        details: row.details,
        instance: 'ESF26-DEV-',
      });
      assert.equal(error, null, `${row.action}: ${error?.message}`);
    }

    const { data: written } = await service.from('audit_logs').select('action, target_id, details').eq('target_id', id).order('id');
    assert.equal(written.length, 3);
    assert.deepEqual(written.map((w) => w.action).sort(), [
      'bank_transfer_recorded', 'bank_transfer_verified', 'booking_auto_confirmed_bank_transfer'
    ].sort());

    await service.from('audit_logs').delete().eq('target_id', id);
  });

  test('anon cannot write audit_logs', async () => {
    const freshAnon = createClient(url, anonKey);
    const { error } = await freshAnon.from('audit_logs').insert({
      action: 'bank_transfer_recorded', target_id: 'x', user_email: 'anon@example.test', details: {}, instance: 'ESF26-DEV-'
    });
    assert.ok(error, 'expected anon to be rejected inserting into audit_logs');
  });
});
