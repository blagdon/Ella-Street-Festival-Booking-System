// Regression tests for the Launch Readiness Review's tenant-isolation
// fixes (migrations 20260805040000 and 20260805050000), all checked
// against the real REST API as genuinely authenticated sessions — reading
// policy SQL is not evidence of live behaviour (see
// privilege-hardening.test.mjs's standing lesson on the same point).
//
// Covers, in order of how the findings were actually discovered:
//   1. bookings/locations/events/booking_locations/email_templates/
//      sms_templates RLS now requires a real per-organisation membership,
//      not just any global user_roles admin row.
//   2. anon has no direct read on locations at all any more; the public map
//      goes through rpc_get_public_locations(org_id, dataset) instead.
//   3. sync_organisation_members_from_user_roles() no longer grants NEW
//      org_default membership as a side effect of an unrelated user_roles
//      write — the actual root cause: every organisation's owner used to
//      become an org_default admin purely by being provisioned.
//   4. is_platform_admin(), redefined to check org_default membership
//      instead of the (organisation-owner-polluted) global user_roles
//      table, still correctly recognises a genuine platform admin.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, adminEmail, adminPassword, service } from './helpers.mjs';

// No password-shaped string literal anywhere in this file (not even inside a
// template literal) - secret scanners like GitGuardian pattern-match the raw
// source text, not the runtime value, so a fixed-looking literal fragment
// (e.g. `Tp-...!Aa1`) still reads as a hardcoded credential even when parts
// of it are interpolated. A full UUID plus a fragment of a second, uppercased,
// plus a symbol gives lower+upper+digit+symbol complexity while staying well
// under GoTrue's 72-character password limit (two full UUIDs, 73 chars, trips
// a 500 from the admin create-user endpoint) - and never appears in source as
// a quoted/backtick literal.
function genTestPassword() {
  return randomUUID() + randomUUID().slice(0, 8).toUpperCase() + '!';
}

const RUN_ID = Date.now();
const ORG_A = `tenant-iso-a-${RUN_ID}`;
const ORG_B = `tenant-iso-b-${RUN_ID}`;
const OWNER_A_EMAIL = `tenant-iso-owner-a-${RUN_ID}@example.test`;
const OWNER_A_PASSWORD = genTestPassword();
const SYNC_PROBE_EMAIL = `tenant-iso-sync-probe-${RUN_ID}@example.test`;

const platformAdmin = createClient(url, anonKey);
let ownerA;
let ownerAId;
let syncProbeUserId;

async function seedOrg(orgId, eventId, bookingId, locationId) {
  await service.from('organisations').insert({ id: orgId, name: `Tenant ${orgId}`, slug: orgId, contact_email: 'owner@example.test' });
  await service.from('events').insert({
    id: eventId, org_id: orgId, name: `${orgId} Event`, slug: `${orgId}-evt`,
    booking_prefix: orgId.slice(-8).toUpperCase(), is_active: true, status: 'open'
  });
  await service.from('bookings').insert({
    id: bookingId, org_id: orgId, event_id: eventId, status: 'Pending',
    business_name: 'Tenant Isolation Test Co', owner_name: 'Test Owner',
    email: 'trader@example.test', instance_prefix: `${orgId}-`, booking_type: 'general',
    payment_link_code: `${bookingId}-code`,
  });
  await service.from('locations').insert({ id: locationId, dataset: 'LIVE', org_id: orgId, lat: 51.0, lng: -0.1 });
  await service.from('email_templates').insert({ org_id: orgId, id: 'application_received', subject: `${orgId} subject`, body_html: `${orgId} body`, description: 'test' });
  await service.from('sms_templates').insert({ org_id: orgId, id: 'booking_received', body: `${orgId} sms body`, description: 'test' });
}

async function cleanupOrg(orgId, eventId, bookingId, locationId) {
  await service.from('booking_locations').delete().eq('booking_id', bookingId);
  await service.from('bookings').delete().eq('id', bookingId);
  await service.from('locations').delete().eq('id', locationId).eq('dataset', 'LIVE');
  await service.from('events').delete().eq('id', eventId);
  await service.from('email_templates').delete().eq('org_id', orgId);
  await service.from('sms_templates').delete().eq('org_id', orgId);
  await service.from('settings').delete().eq('org_id', orgId);
  await service.from('organisation_members').delete().eq('org_id', orgId);
  await service.from('organisations').delete().eq('id', orgId);
}

const EVENT_A = `${ORG_A}-evt`, BOOKING_A = `TISO-A-${RUN_ID}`, LOC_A = `TISOA${RUN_ID}`;
const EVENT_B = `${ORG_B}-evt`, BOOKING_B = `TISO-B-${RUN_ID}`, LOC_B = `TISOB${RUN_ID}`;

before(async () => {
  await seedOrg(ORG_A, EVENT_A, BOOKING_A, LOC_A);
  await seedOrg(ORG_B, EVENT_B, BOOKING_B, LOC_B);

  const { data: created, error: createErr } = await service.auth.admin.createUser({
    email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD, email_confirm: true,
  });
  assert.equal(createErr, null, createErr?.message);
  ownerAId = created.user.id;

  // Owner A is a real admin of ORG_A only — never org_default, never ORG_B.
  // This is the exact shape every genuine customer org owner should have.
  const { error: memberErr } = await service.from('organisation_members').insert({ org_id: ORG_A, user_id: ownerAId, role: 'admin' });
  assert.equal(memberErr, null, memberErr?.message);

  ownerA = createClient(url, anonKey);
  const { error: signInErr } = await ownerA.auth.signInWithPassword({ email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD });
  assert.equal(signInErr, null, signInErr?.message);

  const { error: platformSignInErr } = await platformAdmin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  assert.equal(platformSignInErr, null, `Failed to sign in as test admin (run scripts/seed-test-project.mjs first): ${platformSignInErr?.message}`);
});

after(async () => {
  await cleanupOrg(ORG_A, EVENT_A, BOOKING_A, LOC_A);
  await cleanupOrg(ORG_B, EVENT_B, BOOKING_B, LOC_B);
  if (ownerAId) await service.auth.admin.deleteUser(ownerAId);
  if (syncProbeUserId) {
    await service.from('organisation_members').delete().eq('user_id', syncProbeUserId).eq('org_id', 'org_default');
    await service.from('user_roles').delete().eq('id', syncProbeUserId);
    await service.auth.admin.deleteUser(syncProbeUserId);
  }
});

describe('bookings/locations/events/templates RLS is org-scoped (20260805040000)', () => {
  test('an organisation admin can read and write their own org\'s booking', async () => {
    const { data, error } = await ownerA.from('bookings').select('id').eq('id', BOOKING_A);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 1, 'owner A must see their own booking');

    const { error: updateErr } = await ownerA.from('bookings').update({ status: 'Confirmed' }).eq('id', BOOKING_A);
    assert.equal(updateErr, null, `owner A must be able to update their own org's booking: ${updateErr?.message}`);
  });

  test('an organisation admin cannot read a DIFFERENT org\'s booking', async () => {
    const { data, error } = await ownerA.from('bookings').select('id, email, phone, address').eq('id', BOOKING_B);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 0, 'owner A must not see org B\'s booking (was previously reachable via the global user_roles fallback)');
  });

  test('an organisation admin cannot write a DIFFERENT org\'s booking', async () => {
    const { error } = await ownerA.from('bookings').update({ status: 'Confirmed' }).eq('id', BOOKING_B);
    // PostgREST reports success with zero rows affected when RLS hides the
    // target row, rather than an error — the row's actual state is the only
    // trustworthy assertion (same approach privilege-hardening.test.mjs uses).
    assert.equal(error, null);
    const { data: afterState } = await service.from('bookings').select('status').eq('id', BOOKING_B).single();
    assert.equal(afterState.status, 'Pending', 'org B\'s booking must be unaffected by owner A\'s update attempt');
  });

  test('an organisation admin cannot read a DIFFERENT org\'s locations', async () => {
    const { data, error } = await ownerA.from('locations').select('id').eq('id', LOC_B).eq('dataset', 'LIVE');
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 0);
  });

  test('an organisation admin cannot read a DIFFERENT org\'s events', async () => {
    const { data, error } = await ownerA.from('events').select('id').eq('id', EVENT_B);
    assert.equal(error, null, error?.message);
    assert.equal(data.length, 0);
  });

  test('an organisation admin cannot read a DIFFERENT org\'s email/sms templates', async () => {
    const { data: emailData, error: emailErr } = await ownerA.from('email_templates').select('id').eq('org_id', ORG_B);
    assert.equal(emailErr, null, emailErr?.message);
    assert.equal(emailData.length, 0);

    const { data: smsData, error: smsErr } = await ownerA.from('sms_templates').select('id').eq('org_id', ORG_B);
    assert.equal(smsErr, null, smsErr?.message);
    assert.equal(smsData.length, 0);
  });

  test('a genuine platform admin (org_default) can still read every organisation (regression guard)', async () => {
    const { data: bookingsA } = await platformAdmin.from('bookings').select('id').eq('id', BOOKING_A);
    const { data: bookingsB } = await platformAdmin.from('bookings').select('id').eq('id', BOOKING_B);
    assert.equal(bookingsA.length, 1, 'platform admin must still see org A\'s booking');
    assert.equal(bookingsB.length, 1, 'platform admin must still see org B\'s booking');
  });
});

describe('public locations read goes through rpc_get_public_locations, not a direct table grant (20260805040000, Finding 2)', () => {
  test('anon has no direct SELECT on locations', async () => {
    const trueAnon = createClient(url, anonKey);
    const { data, error } = await trueAnon.from('locations').select('id').eq('dataset', 'LIVE');
    // Either an explicit permission error, or RLS/grant silently returning
    // nothing, both close the enumeration hole - either is an acceptable
    // proof, but seeing every org's rows would not be.
    if (!error) {
      assert.equal(data.length, 0, 'anon must not be able to enumerate locations via the base table');
    }
  });

  test('rpc_get_public_locations returns only the requested organisation\'s rows', async () => {
    const trueAnon = createClient(url, anonKey);
    const { data, error } = await trueAnon.rpc('rpc_get_public_locations', { p_org_id: ORG_A, p_dataset: 'LIVE' });
    assert.equal(error, null, error?.message);
    const ids = (data || []).map((r) => r.id);
    assert.ok(ids.includes(LOC_A), 'must include org A\'s own location');
    assert.ok(!ids.includes(LOC_B), 'must not include org B\'s location');
  });
});

describe('the user_roles → organisation_members sync trigger no longer grants org_default membership (20260805050000)', () => {
  test('a brand-new user_roles admin row does not create an org_default organisation_members row', async () => {
    // Never signed in as, so the password's value genuinely doesn't matter -
    // still routed through genTestPassword() rather than an inline literal,
    // same reasoning as OWNER_A_PASSWORD above.
    const { data: created, error: createErr } = await service.auth.admin.createUser({
      email: SYNC_PROBE_EMAIL, password: genTestPassword(), email_confirm: true,
    });
    assert.equal(createErr, null, createErr?.message);
    syncProbeUserId = created.user.id;

    const { error: roleErr } = await service.from('user_roles').upsert({ id: syncProbeUserId, email: SYNC_PROBE_EMAIL, role: 'admin' }, { onConflict: 'id' });
    assert.equal(roleErr, null, roleErr?.message);

    const { data: memberRow } = await service.from('organisation_members').select('org_id').eq('user_id', syncProbeUserId).eq('org_id', 'org_default').maybeSingle();
    assert.equal(memberRow, null, 'a fresh user_roles admin row must NOT silently grant org_default membership — this is exactly how every provisioned organisation\'s owner ended up an org_default admin');
  });
});

describe('is_platform_admin() reflects real org_default membership, not any global user_roles row (20260805050000)', () => {
  test('an ordinary organisation owner (admin of ORG_A only) is not treated as a platform admin', async () => {
    // Proven indirectly through the RLS tests above (owner A cannot reach
    // org B's rows in any of the tables whose policies OR in
    // is_platform_admin()) — this test asserts the same thing through the
    // organisation_members data directly, as the more direct proof.
    const { data } = await service.from('organisation_members').select('org_id').eq('user_id', ownerAId);
    const orgIds = (data || []).map((r) => r.org_id);
    assert.ok(!orgIds.includes('org_default'), 'owner A must never have been granted org_default membership');
  });
});

describe('bulk messaging and retry are org-scoped (20260805 Edge Function fixes, Finding 4)', () => {
  test('queue-bulk-email cannot be used to email a DIFFERENT organisation\'s booking', async () => {
    const { data: sessionData } = await ownerA.auth.getSession();
    const res = await fetch(`${url}/functions/v1/queue-bulk-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionData.session.access_token}`, apikey: anonKey },
      body: JSON.stringify({ bookingIds: [BOOKING_B], subject: 'test', body: 'test body' }),
    });
    const body = await res.json();
    // BOOKING_B is silently excluded (not Confirmed/wrong org), same as any
    // other ineligible booking — the meaningful assertion is that nothing
    // gets queued for it, not a specific status code.
    assert.ok(res.status >= 400 || body.queued === 0, `must not queue an email for another organisation's booking: ${JSON.stringify(body)}`);

    const { data: queued } = await service.from('email_queue').select('id').eq('org_id', ORG_B).eq('recipient', 'trader@example.test');
    assert.equal((queued || []).length, 0, 'no email_queue row should exist for org B as a result of owner A\'s call');
  });

  test('retry-queued-email cannot be used to retry a DIFFERENT organisation\'s queue entry', async () => {
    const { data: queuedRow, error: insertErr } = await service.from('email_queue').insert({
      org_id: ORG_B, recipient: 'trader@example.test', subject: 'x', body: 'x', status: 'Error',
    }).select().single();
    assert.equal(insertErr, null, insertErr?.message);

    const { data: sessionData } = await ownerA.auth.getSession();
    const res = await fetch(`${url}/functions/v1/retry-queued-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionData.session.access_token}`, apikey: anonKey },
      body: JSON.stringify({ id: queuedRow.id }),
    });
    assert.notEqual(res.status, 200, 'owner A must not be able to retry org B\'s queue entry');

    const { data: afterState } = await service.from('email_queue').select('status').eq('id', queuedRow.id).single();
    assert.equal(afterState.status, 'Error', 'org B\'s queue row must be untouched');

    await service.from('email_queue').delete().eq('id', queuedRow.id);
  });
});

describe('payments/audit_logs/hcc_checks/email_queue/sms_queue RLS is org-scoped (20260806000000)', () => {
  // Same defect shape as the six tables in 20260805040000, found by sweeping
  // for every other table with an org_id column and a check_user_role('admin')-
  // only policy — CLAUDE.md's "sweep for every instance of a pattern" rule.
  // Ground truth seeded directly (service role) with an explicit org_id, so
  // this isolates the RLS question from the separate write-path bug below.
  const payment = { booking_id: BOOKING_B, org_id: ORG_B, paid: true, bank_ref: 'sweep-test', payment_method: 'bank_transfer' };
  const auditRow = { action: 'sweep_test', target_id: BOOKING_B, user_email: 'sweep@example.test', org_id: ORG_B };
  const hccRow = { booking_id: BOOKING_B, org_id: ORG_B, council_status: 'Pending' };
  const emailRow = { org_id: ORG_B, recipient: 'sweep@example.test', subject: 'sweep', body: 'sweep', status: 'Sent' };
  const smsRow = { org_id: ORG_B, recipient: '+447000000099', body: 'sweep', status: 'Sent' };
  let auditId, hccId, emailId, smsId;

  before(async () => {
    await service.from('payments').insert(payment);
    ({ data: { id: auditId } = {} } = await service.from('audit_logs').insert(auditRow).select('id').single());
    ({ data: { id: hccId } = {} } = await service.from('hcc_checks').insert(hccRow).select('id').single());
    ({ data: { id: emailId } = {} } = await service.from('email_queue').insert(emailRow).select('id').single());
    ({ data: { id: smsId } = {} } = await service.from('sms_queue').insert(smsRow).select('id').single());
  });

  after(async () => {
    await service.from('payments').delete().eq('booking_id', BOOKING_B);
    if (auditId) await service.from('audit_logs').delete().eq('id', auditId);
    if (hccId) await service.from('hcc_checks').delete().eq('id', hccId);
    if (emailId) await service.from('email_queue').delete().eq('id', emailId);
    if (smsId) await service.from('sms_queue').delete().eq('id', smsId);
  });

  test('an organisation admin cannot read a DIFFERENT org\'s payments/audit_logs/hcc_checks/email_queue/sms_queue rows', async () => {
    const { data: payments, error: paymentsErr } = await ownerA.from('payments').select('booking_id').eq('booking_id', BOOKING_B);
    assert.equal(paymentsErr, null, paymentsErr?.message);
    assert.equal(payments.length, 0, 'owner A must not see org B\'s payment row');

    const { data: audit, error: auditErr } = await ownerA.from('audit_logs').select('id').eq('id', auditId);
    assert.equal(auditErr, null, auditErr?.message);
    assert.equal(audit.length, 0, 'owner A must not see org B\'s audit_logs row');

    const { data: hcc, error: hccErr } = await ownerA.from('hcc_checks').select('id').eq('id', hccId);
    assert.equal(hccErr, null, hccErr?.message);
    assert.equal(hcc.length, 0, 'owner A must not see org B\'s hcc_checks row');

    const { data: email, error: emailErr } = await ownerA.from('email_queue').select('id').eq('id', emailId);
    assert.equal(emailErr, null, emailErr?.message);
    assert.equal(email.length, 0, 'owner A must not see org B\'s email_queue row');

    const { data: sms, error: smsErr } = await ownerA.from('sms_queue').select('id').eq('id', smsId);
    assert.equal(smsErr, null, smsErr?.message);
    assert.equal(sms.length, 0, 'owner A must not see org B\'s sms_queue row');
  });

  test('a genuine platform admin (org_default) can still read every organisation\'s rows on all five tables (regression guard)', async () => {
    const { data: payments } = await platformAdmin.from('payments').select('booking_id').eq('booking_id', BOOKING_B);
    const { data: audit } = await platformAdmin.from('audit_logs').select('id').eq('id', auditId);
    const { data: hcc } = await platformAdmin.from('hcc_checks').select('id').eq('id', hccId);
    const { data: email } = await platformAdmin.from('email_queue').select('id').eq('id', emailId);
    const { data: sms } = await platformAdmin.from('sms_queue').select('id').eq('id', smsId);
    assert.equal(payments.length, 1, 'platform admin must still see org B\'s payment row');
    assert.equal(audit.length, 1, 'platform admin must still see org B\'s audit_logs row');
    assert.equal(hcc.length, 1, 'platform admin must still see org B\'s hcc_checks row');
    assert.equal(email.length, 1, 'platform admin must still see org B\'s email_queue row');
    assert.equal(sms.length, 1, 'platform admin must still see org B\'s sms_queue row');
  });
});

describe('finalize_stripe_payment tags the payment with the booking\'s real org_id, not org_default (20260806000000)', () => {
  const bookingId = `TISO-STRIPE-${RUN_ID}`;

  before(async () => {
    await service.from('bookings').insert({
      id: bookingId, org_id: ORG_B, event_id: EVENT_B, status: 'Payment Requested',
      business_name: 'Stripe Org-Tagging Test', owner_name: 'Test Owner',
      email: 'trader@example.test', instance_prefix: `${ORG_B}-`, booking_type: 'general',
      payment_link_code: `${bookingId}-code`,
    });
  });

  after(async () => {
    await service.from('payments').delete().eq('booking_id', bookingId);
    await service.from('bookings').delete().eq('id', bookingId);
  });

  test('a Stripe auto-confirmed payment is tagged with the booking\'s own org_id', async () => {
    const { error } = await service.rpc('finalize_stripe_payment', { p_booking_id: bookingId, p_payment_intent_id: 'pi_sweep_test' });
    assert.equal(error, null, error?.message);

    const { data: row } = await service.from('payments').select('org_id, paid').eq('booking_id', bookingId).single();
    assert.equal(row.paid, true, 'expected the payment to be recorded as paid');
    assert.equal(row.org_id, ORG_B, 'expected the payment to be tagged with the booking\'s real org, not silently defaulted to org_default');
  });
});
