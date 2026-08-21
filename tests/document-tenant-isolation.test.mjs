// Regression tests for E5-01/E5-02: get-booking-documents checked admin
// status against the global user_roles table (any org's admin, not
// org-scoped) and looked up the target booking with no org filter at all —
// so an admin of Organisation A, given Organisation B's booking id, could
// retrieve signed URLs to Organisation B's uploaded regulatory/insurance
// documents. Separately, the shared getBucketName() helper resolved the
// document storage bucket with an org-unfiltered settings query, so once a
// second organisation's bucket_name row existed it silently resolved the
// wrong (fallback) bucket for every caller rather than each org's own.
//
// Fixed by:
//   1. Replacing the user_roles check in get-booking-documents with
//      resolveCallerAdminScope() (mirrors retry-queued-sms/refund-payment).
//   2. Selecting org_id on the booking and scoping the lookup query itself
//      to the caller's org set — a cross-tenant booking id now reads as a
//      plain 404, never confirming the booking exists in another org.
//   3. Requiring an explicit orgId argument on getBucketName() (no
//      org_default default), scoping its settings query by it, and using
//      maybeSingle() instead of single() so "this org hasn't set one yet"
//      is a normal case, not a swallowed error.
//   4. Passing the booking's own (now-authorised) org_id into
//      getBucketName() from both get-booking-documents and submit-booking.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, adminEmail, adminPassword, service, callEdgeFunction } from './helpers.mjs';

// See tenant-isolation.test.mjs's identical helper/comment: avoids a
// fixed-looking password literal that would trip secret-scanner pattern
// matching, while staying under GoTrue's 72-character limit.
function genTestPassword() {
  return randomUUID() + randomUUID().slice(0, 8).toUpperCase() + '!';
}

// ORG_A/ORG_B differ only before the shared RUN_ID suffix, which a trailing
// slice would cut off entirely (see rpc-authorisation.test.mjs's identical
// shortHash). Hashing the full string keeps the distinguishing text
// participating, so EVENT_A/EVENT_B get distinct booking_prefix values.
function shortHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h.toString(36).toUpperCase().padStart(8, '0').slice(-8);
}

const RUN_ID = Date.now();
const ORG_A = `e501-org-a-${RUN_ID}`;
const ORG_B = `e501-org-b-${RUN_ID}`;
const EVENT_A = `${ORG_A}-evt`;
const EVENT_B = `${ORG_B}-evt`;
const OWNER_A_EMAIL = `e501-owner-a-${RUN_ID}@example.test`;
const OWNER_A_PASSWORD = genTestPassword();
const STEWARD_A_EMAIL = `e501-steward-a-${RUN_ID}@example.test`;
const STEWARD_A_PASSWORD = genTestPassword();

const BOOKING_A = `E501-A-${RUN_ID}`;
const BOOKING_B = `E501-B-${RUN_ID}`;

// The default bucket every org falls back to (same one seed-test-project.mjs
// and integration.test.mjs's document-move tests already use) — ORG_A relies
// on this to prove the fix doesn't break the common, unconfigured case.
const DEFAULT_BUCKET = 'esf-documents';
// A genuinely separate, disposable bucket ORG_B explicitly configures — proves
// getBucketName() resolves each org's OWN value rather than the default/
// another org's value once a second organisation configures a custom one.
const ORG_B_BUCKET = `e501-org-b-bucket-${RUN_ID}`;

// esf-documents enforces a pdf/jpg/jpeg-only upload policy (see the
// "Strict Public Uploads" storage policy) — .pdf, not .txt, so the seed
// upload itself isn't rejected regardless of which bucket ends up used.
const DOC_A_PATH = `${BOOKING_A}/e501-doc-a.pdf`;
const DOC_B_PATH = `${BOOKING_B}/e501-doc-b.pdf`;
const DOC_A_CONTENT = `%PDF-1.4 org-a-document-${RUN_ID}`;
const DOC_B_CONTENT = `%PDF-1.4 org-b-document-${RUN_ID}`;

let ownerAId, stewardAId;
let ownerA, stewardA, platformAdmin;

async function seedOrgWithDocument(orgId, eventId, bookingId, docPath, docContent, bucketName) {
  const { error: orgErr } = await service.from('organisations')
    .insert({ id: orgId, name: `E5-01/02 Test ${orgId}`, slug: orgId, contact_email: 'owner@example.test' });
  assert.equal(orgErr, null, orgErr?.message);

  // Phase 2C (composite bookings_org_event_fkey): a booking's event_id must
  // now belong to the SAME org_id, so this brand-new org needs its own real
  // event rather than reusing 'event_default' (which belongs to org_default).
  const { error: evtErr } = await service.from('events')
    .insert({ id: eventId, org_id: orgId, name: `${orgId} Event`, slug: `${orgId}-evt`, booking_prefix: shortHash(eventId), status: 'open' });
  assert.equal(evtErr, null, evtErr?.message);

  const { error: bErr } = await service.from('bookings').insert({
    id: bookingId, org_id: orgId, event_id: eventId, status: 'Confirmed',
    business_name: 'E5-01/02 Test Co', owner_name: 'Test Owner',
    email: 'trader@example.test', instance_prefix: `${orgId}-DEV-`,
    stall_type: 'Food', stall_cost: 100,
    documents: [docPath],
  });
  assert.equal(bErr, null, bErr?.message);

  const { error: settingsErr } = await service.from('settings')
    .insert({ org_id: orgId, key: 'bucket_name', value: bucketName });
  assert.equal(settingsErr, null, settingsErr?.message);

  const { error: upErr } = await service.storage.from(bucketName)
    .upload(docPath, Buffer.from(docContent), { contentType: 'application/pdf' });
  assert.equal(upErr, null, `document upload to ${bucketName}/${docPath} failed: ${upErr?.message}`);
}

async function cleanupOrg(orgId, eventId, bookingId, docPath, bucketName) {
  await service.storage.from(bucketName).remove([docPath]).catch(() => {});
  await service.from('bookings').delete().eq('id', bookingId);
  await service.from('settings').delete().eq('org_id', orgId);
  await service.from('organisation_members').delete().eq('org_id', orgId);
  await service.from('events').delete().eq('id', eventId);
  await service.from('organisations').delete().eq('id', orgId);
}

async function tokenFor(client) {
  const { data } = await client.auth.getSession();
  return data.session.access_token;
}

before(async () => {
  // ORG_B gets its own genuinely separate bucket — created here, deleted in
  // after(). ORG_A deliberately reuses the shared DEFAULT_BUCKET (the
  // ordinary, unconfigured case every org starts in).
  const { error: bucketErr } = await service.storage.createBucket(ORG_B_BUCKET, { public: false });
  assert.equal(bucketErr, null, bucketErr?.message);

  await seedOrgWithDocument(ORG_A, EVENT_A, BOOKING_A, DOC_A_PATH, DOC_A_CONTENT, DEFAULT_BUCKET);
  await seedOrgWithDocument(ORG_B, EVENT_B, BOOKING_B, DOC_B_PATH, DOC_B_CONTENT, ORG_B_BUCKET);

  const { data: ownerCreated, error: ownerErr } = await service.auth.admin.createUser({
    email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD, email_confirm: true,
  });
  assert.equal(ownerErr, null, ownerErr?.message);
  ownerAId = ownerCreated.user.id;
  // A real admin of ORG_A only - never org_default, never ORG_B. Also given
  // a user_roles row (role: 'admin'), matching exactly what
  // rpc_add_organisation_member() writes for every real admin invited
  // through the normal flow - without it, this fixture wouldn't reach the
  // OLD (pre-fix) global user_roles admin check at all, which would make
  // "this test fails against the vulnerable implementation" untrue: the old
  // code's own admin gate, not the org-scoping fix, would be what rejected
  // it, for an unrelated reason.
  const { error: memberErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_A, user_id: ownerAId, role: 'admin' });
  assert.equal(memberErr, null, memberErr?.message);
  const { error: legacyRoleErr } = await service.from('user_roles')
    .insert({ id: ownerAId, email: OWNER_A_EMAIL, role: 'admin' });
  assert.equal(legacyRoleErr, null, legacyRoleErr?.message);

  ownerA = createClient(url, anonKey);
  const { error: signInErr } = await ownerA.auth.signInWithPassword({ email: OWNER_A_EMAIL, password: OWNER_A_PASSWORD });
  assert.equal(signInErr, null, signInErr?.message);

  const { data: stewardCreated, error: stewardErr } = await service.auth.admin.createUser({
    email: STEWARD_A_EMAIL, password: STEWARD_A_PASSWORD, email_confirm: true,
  });
  assert.equal(stewardErr, null, stewardErr?.message);
  stewardAId = stewardCreated.user.id;
  const { error: stewardMemberErr } = await service.from('organisation_members')
    .insert({ org_id: ORG_A, user_id: stewardAId, role: 'steward' });
  assert.equal(stewardMemberErr, null, stewardMemberErr?.message);

  stewardA = createClient(url, anonKey);
  const { error: stewardSignInErr } = await stewardA.auth.signInWithPassword({ email: STEWARD_A_EMAIL, password: STEWARD_A_PASSWORD });
  assert.equal(stewardSignInErr, null, stewardSignInErr?.message);

  platformAdmin = createClient(url, anonKey);
  const { error: platformSignInErr } = await platformAdmin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  assert.equal(platformSignInErr, null, platformSignInErr?.message);
});

after(async () => {
  await cleanupOrg(ORG_A, EVENT_A, BOOKING_A, DOC_A_PATH, DEFAULT_BUCKET);
  await cleanupOrg(ORG_B, EVENT_B, BOOKING_B, DOC_B_PATH, ORG_B_BUCKET);
  await service.storage.deleteBucket(ORG_B_BUCKET).catch(() => {});
  if (ownerAId) await service.from('user_roles').delete().eq('id', ownerAId);
  if (ownerAId) await service.auth.admin.deleteUser(ownerAId);
  if (stewardAId) await service.auth.admin.deleteUser(stewardAId);
});

describe('E5-02: get-booking-documents cross-tenant authorization', () => {
  test('Test 1 - Org A\'s own admin can retrieve Org A\'s own booking documents (genuinely accessible)', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('get-booking-documents', { bookingId: BOOKING_A }, token);

    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.documents.length, 1);
    assert.ok(json.documents[0], 'expected a real signed URL, not null');

    // Genuinely accessible, not just a well-formed URL string: fetch it and
    // confirm it returns ORG_A's actual document content.
    const res = await fetch(json.documents[0]);
    assert.equal(res.status, 200, `signed URL did not resolve: ${res.status}`);
    const body = await res.text();
    assert.equal(body, DOC_A_CONTENT);
  });

  test('Test 2 (critical regression test) - an Org A admin CANNOT retrieve Org B\'s booking documents', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('get-booking-documents', { bookingId: BOOKING_B }, token);

    // Rejected before any bucket/storage operation: a plain 404 (not visible
    // in the caller's own org scope), not a 403 that would confirm the
    // booking exists in another organisation, and no documents array at all.
    assert.equal(status, 404, `cross-tenant document access must be rejected as not-found, got ${status}: ${JSON.stringify(json)}`);
    assert.equal(json.documents, undefined, 'no document information of any kind must be returned for a cross-tenant booking');
  });

  test('Test 3 - a non-admin (steward) of Org A is rejected outright, even for their own org\'s booking', async () => {
    const token = await tokenFor(stewardA);
    const { status, json } = await callEdgeFunction('get-booking-documents', { bookingId: BOOKING_A }, token);
    assert.equal(status, 403, JSON.stringify(json));
    assert.match(json.error, /Admin role required/i);
    assert.equal(json.documents, undefined);
  });

  test('Test 4 - a booking id that does not exist at all is rejected as not-found, not silently treated as any org\'s', async () => {
    const token = await tokenFor(ownerA);
    const { status, json } = await callEdgeFunction('get-booking-documents', { bookingId: `${BOOKING_A}-DOES-NOT-EXIST` }, token);
    assert.equal(status, 404, JSON.stringify(json));
  });

  test('Test 5 - a genuine platform admin (org_default) can still retrieve another organisation\'s booking documents (regression guard)', async () => {
    const token = await tokenFor(platformAdmin);
    const { status, json } = await callEdgeFunction('get-booking-documents', { bookingId: BOOKING_B }, token);

    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.documents.length, 1);
    assert.ok(json.documents[0], 'platform admin must still get a real signed URL for another org\'s booking');

    const res = await fetch(json.documents[0]);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, DOC_B_CONTENT, 'platform admin must see ORG_B\'s real document, proving the bypass is intentional and correctly scoped, not accidental');
  });
});

describe('E5-01: getBucketName() bucket isolation', () => {
  test('Test 6 - Org A and Org B resolve to their own genuinely distinct buckets, never each other\'s or a shared default', async () => {
    // Exercised entirely through the real get-booking-documents endpoint
    // (not a hand-rolled reimplementation of getBucketName()) — each org's
    // admin retrieves their own booking, and the returned signed URL's
    // content is checked against what only exists in THAT org's own bucket.
    // If getBucketName() were still unscoped, ORG_B's booking (whose only
    // configured bucket_name row is now the second row in the settings
    // table) would either error (old single()-without-org-filter behaviour)
    // or silently resolve DEFAULT_BUCKET instead of ORG_B_BUCKET — in
    // either case ORG_B's document, which exists ONLY in ORG_B_BUCKET,
    // would not be found: entry.error set, a null document, not
    // DOC_B_CONTENT.
    const tokenA = await tokenFor(ownerA);
    const { status: statusA, json: jsonA } = await callEdgeFunction('get-booking-documents', { bookingId: BOOKING_A }, tokenA);
    assert.equal(statusA, 200, JSON.stringify(jsonA));
    const resA = await fetch(jsonA.documents[0]);
    assert.equal(resA.status, 200);
    assert.equal(await resA.text(), DOC_A_CONTENT, 'Org A must resolve its own (default) bucket');

    const tokenPlatform = await tokenFor(platformAdmin);
    const { status: statusB, json: jsonB } = await callEdgeFunction('get-booking-documents', { bookingId: BOOKING_B }, tokenPlatform);
    assert.equal(statusB, 200, JSON.stringify(jsonB));
    assert.ok(jsonB.documents[0], 'Org B\'s document must resolve to a real signed URL in ITS OWN bucket, not fail because the wrong bucket was queried');
    const resB = await fetch(jsonB.documents[0]);
    assert.equal(resB.status, 200, `Org B's signed URL did not resolve — likely resolved the wrong bucket: ${resB.status}`);
    assert.equal(await resB.text(), DOC_B_CONTENT, 'Org B must resolve its OWN distinct bucket, not the default or Org A\'s');
  });
});
