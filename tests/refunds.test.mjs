// Behavioural tests for refund recording (20260721100000_add_refund_support.sql).
//
// This is a money path, so per HANDOVER's agent-autonomy policy the path is
// exercised for real rather than reasoned about: every check here goes through
// the actual RPC as a genuinely authenticated session, and the assertions are
// on stored state, not on what the call returned.
//
// Nothing here touches Stripe. rpc_record_refund deliberately only RECORDS a
// refund that happened elsewhere - it moves no money - which is exactly what
// makes it safe to test exhaustively.
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
const adminEmail = process.env.TEST_ADMIN_EMAIL;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;

if (!url || !url.includes('qeplpcnrkgpaawfyliap')) {
  throw new Error(`Refusing to run integration tests against a non-test project: ${url}`);
}

const authed = createClient(url, anonKey);
const service = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

const PREFIX = 'ESF26-DEV-REFUND';
let adminUserId;

before(async () => {
  const { data, error } = await authed.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw new Error(`Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${error.message}`);
  adminUserId = data.user.id;

  await service.from('payments').delete().like('booking_id', `${PREFIX}%`);
  await service.from('bookings').delete().like('id', `${PREFIX}%`);
});

after(async () => {
  await service.from('payments').delete().like('booking_id', `${PREFIX}%`);
  await service.from('bookings').delete().like('id', `${PREFIX}%`);
  await service.from('user_roles').update({ role: 'admin' }).eq('id', adminUserId);
});

/** Creates a Confirmed booking with a recorded payment, ready to refund. */
async function seedPaidBooking(id, { stallCost = 100, paid = true, method = 'stripe' } = {}) {
  await service.from('payments').delete().eq('booking_id', id);
  await service.from('bookings').delete().eq('id', id);

  const { error: bErr } = await service.from('bookings').insert({
    id,
    status: 'Confirmed',
    business_name: 'Refund Test Co',
    owner_name: 'Test Owner',
    email: 'refund-test@example.test',
    instance_prefix: 'ESF26-DEV-',
    stall_type: 'Food',
    stall_cost: stallCost,
  });
  assert.equal(bErr, null, bErr?.message);

  const { error: pErr } = await service.from('payments').insert({
    booking_id: id,
    paid,
    date_paid: paid ? new Date().toISOString().split('T')[0] : null,
    payment_method: method,
    editor: 'test',
  });
  assert.equal(pErr, null, pErr?.message);
}

describe('rpc_record_refund', () => {
  test('records a full refund and stamps the actor from the JWT, not the client', async () => {
    const id = `${PREFIX}-0001`;
    await seedPaidBooking(id);

    const { error } = await authed.rpc('rpc_record_refund', {
      p_booking_id: id,
      p_refund_amount: 100,
      p_refund_reference: 're_test_full',
      p_notes: 'Trader cancelled',
      // Deliberately attempting to attribute the refund to someone else -
      // must be ignored for an authenticated admin, same guarantee the
      // audit-log trigger enforces.
      p_refunded_by: 'someone-else@evil.test',
    });
    assert.equal(error, null, error?.message);

    const { data } = await service.from('payments')
      .select('refund_amount, refunded_at, refunded_by, refund_reference, refund_notes, paid')
      .eq('booking_id', id).single();

    assert.equal(Number(data.refund_amount), 100);
    assert.ok(data.refunded_at, 'refunded_at must be stamped');
    assert.equal(data.refunded_by, adminEmail, 'refunded_by must come from the JWT, not p_refunded_by');
    assert.notEqual(data.refunded_by, 'someone-else@evil.test');
    assert.equal(data.refund_reference, 're_test_full');
    assert.equal(data.refund_notes, 'Trader cancelled');
    assert.equal(data.paid, true, 'paid stays true - the payment did happen; the refund is separate state');
  });

  test('records a partial refund', async () => {
    const id = `${PREFIX}-0002`;
    await seedPaidBooking(id, { stallCost: 100 });

    const { error } = await authed.rpc('rpc_record_refund', {
      p_booking_id: id, p_refund_amount: 40, p_refund_reference: 're_test_partial', p_notes: null,
    });
    assert.equal(error, null, error?.message);

    const { data } = await service.from('payments').select('refund_amount').eq('booking_id', id).single();
    assert.equal(Number(data.refund_amount), 40);
  });

  test('rejects a refund larger than the booking cost', async () => {
    const id = `${PREFIX}-0003`;
    await seedPaidBooking(id, { stallCost: 100 });

    const { error } = await authed.rpc('rpc_record_refund', {
      p_booking_id: id, p_refund_amount: 150, p_refund_reference: 're_test_toobig', p_notes: null,
    });
    assert.ok(error, 'a refund exceeding the booking cost must be rejected');
    assert.match(error.message, /exceeds the booking cost/i);

    const { data } = await service.from('payments').select('refund_amount').eq('booking_id', id).single();
    assert.equal(data.refund_amount, null, 'nothing must have been written');
  });

  test('rejects a zero or negative refund', async () => {
    const id = `${PREFIX}-0004`;
    await seedPaidBooking(id);

    for (const amount of [0, -10]) {
      const { error } = await authed.rpc('rpc_record_refund', {
        p_booking_id: id, p_refund_amount: amount, p_refund_reference: 're_x', p_notes: null,
      });
      assert.ok(error, `refund amount ${amount} must be rejected`);
    }
  });

  test('rejects a missing refund reference', async () => {
    const id = `${PREFIX}-0005`;
    await seedPaidBooking(id);

    const { error } = await authed.rpc('rpc_record_refund', {
      p_booking_id: id, p_refund_amount: 50, p_refund_reference: '   ', p_notes: null,
    });
    assert.ok(error, 'a blank reference must be rejected');
    assert.match(error.message, /reference is required/i);
  });

  test('refuses to refund a booking twice (only one refund per booking is representable)', async () => {
    const id = `${PREFIX}-0006`;
    await seedPaidBooking(id);

    const { error: firstErr } = await authed.rpc('rpc_record_refund', {
      p_booking_id: id, p_refund_amount: 50, p_refund_reference: 're_first', p_notes: null,
    });
    assert.equal(firstErr, null, firstErr?.message);

    const { error: secondErr } = await authed.rpc('rpc_record_refund', {
      p_booking_id: id, p_refund_amount: 25, p_refund_reference: 're_second', p_notes: null,
    });
    assert.ok(secondErr, 'a second refund must be rejected, not silently overwrite the first');
    assert.match(secondErr.message, /already been refunded/i);

    const { data } = await service.from('payments').select('refund_amount, refund_reference').eq('booking_id', id).single();
    assert.equal(Number(data.refund_amount), 50, 'the original refund must be intact');
    assert.equal(data.refund_reference, 're_first');
  });

  test('rpc_record_refund is atomic: only one of two concurrent partial refunds wins', async () => {
    const id = `${PREFIX}-0006B`;
    // Both amounts individually fit within stallCost (100), which is exactly
    // the dangerous case a plain SELECT-then-UPDATE check misses: for a FULL
    // refund, Stripe's own ledger would reject the second one regardless -
    // but two partial refunds that both fit can genuinely both succeed at
    // Stripe, so this RPC's own claim has to be the thing that stops a
    // second one being recorded, not an assumption about the caller.
    await seedPaidBooking(id, { stallCost: 100 });

    const [r1, r2] = await Promise.all([
      authed.rpc('rpc_record_refund', { p_booking_id: id, p_refund_amount: 40, p_refund_reference: 're_race_1', p_notes: null }),
      authed.rpc('rpc_record_refund', { p_booking_id: id, p_refund_amount: 40, p_refund_reference: 're_race_2', p_notes: null }),
    ]);

    const winners = [r1, r2].filter((r) => r.error === null);
    const losers = [r1, r2].filter((r) => r.error !== null);
    assert.equal(winners.length, 1,
      `exactly one concurrent refund should be recorded, got ${winners.length} - ` +
      `two winners would mean a booking refunded twice at Stripe shows only one (or an inconsistent) refund here`);
    assert.equal(losers.length, 1);
    assert.match(losers[0].error.message, /already been refunded/i);

    const { data } = await service.from('payments').select('refund_amount, refund_reference').eq('booking_id', id).single();
    assert.equal(Number(data.refund_amount), 40, 'the single recorded refund must be internally consistent');
    assert.ok(['re_race_1', 're_race_2'].includes(data.refund_reference));
  });

  test('refuses to refund a booking with no recorded payment', async () => {
    const id = `${PREFIX}-0007`;
    await seedPaidBooking(id, { paid: false });

    const { error } = await authed.rpc('rpc_record_refund', {
      p_booking_id: id, p_refund_amount: 50, p_refund_reference: 're_unpaid', p_notes: null,
    });
    assert.ok(error, 'refunding an unpaid booking must be rejected');
    assert.match(error.message, /no recorded payment/i);
  });

  test('refuses a booking that does not exist', async () => {
    const { error } = await authed.rpc('rpc_record_refund', {
      p_booking_id: `${PREFIX}-9999`, p_refund_amount: 10, p_refund_reference: 're_ghost', p_notes: null,
    });
    assert.ok(error, 'a nonexistent booking must be rejected');
    assert.match(error.message, /not found/i);
  });
});

describe('rpc_record_refund authorization', () => {
  test('anon cannot call it', async () => {
    const trueAnon = createClient(url, anonKey);
    const { error } = await trueAnon.rpc('rpc_record_refund', {
      p_booking_id: `${PREFIX}-0001`, p_refund_amount: 10, p_refund_reference: 're_anon', p_notes: null,
    });
    assert.ok(error, 'anon must be rejected calling a money-mutating RPC');
  });

  test('a steward cannot call it', async () => {
    const id = `${PREFIX}-0008`;
    await seedPaidBooking(id);

    await service.from('user_roles').update({ role: 'steward' }).eq('id', adminUserId);
    try {
      const { error } = await authed.rpc('rpc_record_refund', {
        p_booking_id: id, p_refund_amount: 10, p_refund_reference: 're_steward', p_notes: null,
      });
      assert.ok(error, 'a steward-role session must be rejected');
      assert.match(error.message, /not authorized/i);
    } finally {
      await service.from('user_roles').update({ role: 'admin' }).eq('id', adminUserId);
    }

    const { data } = await service.from('payments').select('refund_amount').eq('booking_id', id).single();
    assert.equal(data.refund_amount, null, 'the steward attempt must not have written anything');
  });
});

describe('refund-payment Edge Function (guard rails only — never issues a real refund here)', () => {
  // Every test below asserts a REJECTION. None reaches stripe.refunds.create(),
  // deliberately: the test project has only Test-mode keys, but issuing even a
  // test-mode refund would require first creating a real charge to refund, and
  // an automated suite that can move money — in any mode — is not something
  // worth having. The success path is covered by rpc_record_refund's own tests
  // (the function calls that RPC to record its result) plus manual
  // verification against Stripe Test mode.
  async function callRefund(body, token) {
    const res = await fetch(`${url}/functions/v1/refund-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: anonKey },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  let adminToken;
  before(async () => {
    const { data } = await authed.auth.getSession();
    adminToken = data.session.access_token;
  });

  test('rejects an unauthenticated caller', async () => {
    const { status } = await callRefund({ booking_id: `${PREFIX}-0001` }, anonKey);
    assert.equal(status, 401);
  });

  test('rejects a booking with no recorded payment', async () => {
    const id = `${PREFIX}-0010`;
    await seedPaidBooking(id, { paid: false });
    const { status, json } = await callRefund({ booking_id: id }, adminToken);
    assert.equal(status, 409, JSON.stringify(json));
    assert.match(json.error, /no recorded payment/i);
  });

  test('refuses to auto-refund a bank transfer, directing the admin to the manual path', async () => {
    const id = `${PREFIX}-0011`;
    await seedPaidBooking(id, { method: 'bank_transfer' });
    const { status, json } = await callRefund({ booking_id: id }, adminToken);
    assert.equal(status, 409, JSON.stringify(json));
    assert.match(json.error, /Only Stripe payments can be refunded automatically/i);
  });

  test('refuses a Stripe payment with no payment intent recorded', async () => {
    const id = `${PREFIX}-0012`;
    await seedPaidBooking(id, { method: 'stripe' }); // seeds no stripe_payment_intent_id
    const { status, json } = await callRefund({ booking_id: id }, adminToken);
    assert.equal(status, 409, JSON.stringify(json));
    assert.match(json.error, /no Stripe payment intent/i);
  });

  test('refuses an already-refunded booking BEFORE calling Stripe', async () => {
    const id = `${PREFIX}-0013`;
    await seedPaidBooking(id, { method: 'stripe' });
    await service.from('bookings').update({ stripe_payment_intent_id: 'pi_test_already' }).eq('id', id);
    await service.from('payments').update({ refund_amount: 50, refunded_at: new Date().toISOString() }).eq('booking_id', id);

    const { status, json } = await callRefund({ booking_id: id }, adminToken);
    assert.equal(status, 409, JSON.stringify(json));
    assert.match(json.error, /already been refunded/i);
  });

  test('rejects a refund larger than the booking cost before calling Stripe', async () => {
    const id = `${PREFIX}-0014`;
    await seedPaidBooking(id, { stallCost: 100, method: 'stripe' });
    await service.from('bookings').update({ stripe_payment_intent_id: 'pi_test_toobig' }).eq('id', id);

    const { status, json } = await callRefund({ booking_id: id, amount: 500 }, adminToken);
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(json.error, /exceeds the booking cost/i);
  });

  test('returns 404 for a booking that does not exist', async () => {
    const { status } = await callRefund({ booking_id: `${PREFIX}-9998` }, adminToken);
    assert.equal(status, 404);
  });
});

describe('webhook reconciliation path (rpc_record_refund as service_role)', () => {
  test('a service_role caller may attribute the refund to Stripe, unlike an admin', async () => {
    // This is the charge.refunded path: no auth.uid(), so p_refunded_by is
    // honoured. The admin equivalent of this is asserted to be IGNORED above,
    // which is the distinction that matters.
    const id = `${PREFIX}-0020`;
    await seedPaidBooking(id, { method: 'stripe' });

    const { error } = await service.rpc('rpc_record_refund', {
      p_booking_id: id,
      p_refund_amount: 100,
      p_refund_reference: 're_from_webhook',
      p_notes: 'Recorded automatically from Stripe charge.refunded.',
      p_refunded_by: 'Stripe (automatic)',
    });
    assert.equal(error, null, error?.message);

    const { data } = await service.from('payments').select('refunded_by, refund_reference').eq('booking_id', id).single();
    assert.equal(data.refunded_by, 'Stripe (automatic)');
    assert.equal(data.refund_reference, 're_from_webhook');
  });

  test('a duplicate webhook delivery is rejected as already-refunded, which the webhook treats as success', async () => {
    // The webhook special-cases this exact message rather than 500ing, so a
    // Stripe retry (or the API-initiated refund's own webhook arriving after
    // refund-payment already recorded it) doesn't loop forever.
    const id = `${PREFIX}-0021`;
    await seedPaidBooking(id, { method: 'stripe' });

    const args = {
      p_booking_id: id, p_refund_amount: 100, p_refund_reference: 're_dup',
      p_notes: null, p_refunded_by: 'Stripe (automatic)',
    };
    const { error: firstErr } = await service.rpc('rpc_record_refund', args);
    assert.equal(firstErr, null, firstErr?.message);

    const { error: secondErr } = await service.rpc('rpc_record_refund', args);
    assert.ok(secondErr, 'the second delivery must be rejected');
    assert.match(secondErr.message, /already been refunded/i,
      'the webhook matches on this exact wording to distinguish a benign duplicate from a real failure');
  });
});

describe('stats page refund visibility (bookings → payments embed)', () => {
  test('an authenticated admin can read refund_amount through the exact query shape fetchStatsData uses', async () => {
    // The stats page joins refunds via PostgREST's embedded select rather
    // than a second query. This asserts the whole chain that join depends
    // on — the payments_booking_id_fkey relationship being visible to
    // PostgREST, and RLS letting an admin session read refund_amount
    // through the embed — because if any link breaks, the stats page
    // doesn't degrade to £0, it fails to load at all.
    const id = `${PREFIX}-0030`;
    await seedPaidBooking(id, { stallCost: 100 });

    const { error: refundErr } = await authed.rpc('rpc_record_refund', {
      p_booking_id: id, p_refund_amount: 60, p_refund_reference: 're_stats_embed', p_notes: null,
    });
    assert.equal(refundErr, null, refundErr?.message);

    const { data, error } = await authed.from('bookings')
      .select('*, payments(refund_amount)')
      .eq('id', id)
      .single();
    assert.equal(error, null, error?.message);

    // payments' PK is booking_id, so PostgREST should detect one-to-one and
    // embed an object; the page tolerates the array shape too, so accept both.
    const p = Array.isArray(data.payments) ? data.payments[0] : data.payments;
    assert.equal(Number(p?.refund_amount), 60);
  });

  test('a booking with no payments row embeds a null, not an error', async () => {
    const id = `${PREFIX}-0031`;
    await seedPaidBooking(id);
    await service.from('payments').delete().eq('booking_id', id);

    const { data, error } = await authed.from('bookings')
      .select('*, payments(refund_amount)')
      .eq('id', id)
      .single();
    assert.equal(error, null, error?.message);
    const p = Array.isArray(data.payments) ? data.payments[0] : data.payments;
    assert.equal(p?.refund_amount ?? null, null);
  });
});

describe('the payments_refund_requires_payment constraint', () => {
  test('the database itself rejects a refund on an unpaid row, not just the RPC', async () => {
    // Guards the case the RPC does not cover: a direct write by
    // service_role (the Stripe webhook path, added in the follow-up
    // migration) must not be able to record a refund against an unpaid row.
    const id = `${PREFIX}-0009`;
    await seedPaidBooking(id, { paid: false });

    const { error } = await service.from('payments')
      .update({ refund_amount: 50 })
      .eq('booking_id', id);

    assert.ok(error, 'the CHECK constraint must reject a refund on an unpaid payments row');
  });
});
