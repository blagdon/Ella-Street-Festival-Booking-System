// Regression tests for 20260818100000_harden_storage_objects_rls.sql.
//
// Before this migration, storage.objects RLS on the test project granted
// `public`/`anon` unrestricted SELECT and, for esf-documents, INSERT/UPDATE
// with no path scoping at all - completely bypassing the buckets' own
// `public = false` flag. Production already had a narrower single policy
// (anon INSERT only, extension/size-restricted) but still had no path
// restriction, so an anonymous caller could plant a file at an arbitrary
// path inside the private bucket, including inside an existing booking's
// own folder.
//
// The fix narrows storage.objects to exactly one policy: anon/public INSERT
// into esf-documents' `temp/` staging prefix only, matching the extension
// (pdf/jpg/jpeg/png) and size (5MB) limits already enforced client-side in
// js/page-food-booking.js and js/page-general-booking.js. No anon/public
// SELECT, UPDATE, or DELETE exists anywhere - the only legitimate readers
// (get-booking-documents) and movers (submit-booking) are both service_role,
// which bypasses RLS entirely and needs no policy of its own.
//
// Setup required first: node scripts/seed-test-project.mjs
// Run: npm run test:integration
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { url, anonKey, service } from './helpers.mjs';

const RUN_ID = Date.now();
const BUCKET = 'esf-documents';
const EXISTING_BOOKING_ID = `E5STOR-EXISTING-${RUN_ID}`;
const TEMP_UUID = `${RUN_ID}-temp-uuid`;
const EXISTING_DOC_PATH = `${EXISTING_BOOKING_ID}/existing-doc.pdf`;
const EXISTING_DOC_CONTENT = `%PDF-1.4 existing-booking-document-${RUN_ID}`;

const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });

const pathsToCleanup = [
  EXISTING_DOC_PATH,
  `temp/${TEMP_UUID}/legit-upload.pdf`,
  `temp/${TEMP_UUID}/wrong-extension.txt`,
  `${EXISTING_BOOKING_ID}/planted-by-anon.pdf`,
];

before(async () => {
  // A pre-existing "booking's own document" - service_role only, exactly
  // how submit-booking's own move operation writes it in production.
  const { error } = await service.storage.from(BUCKET)
    .upload(EXISTING_DOC_PATH, Buffer.from(EXISTING_DOC_CONTENT), { contentType: 'application/pdf' });
  assert.equal(error, null, `fixture upload failed: ${error?.message}`);
});

after(async () => {
  await service.storage.from(BUCKET).remove(pathsToCleanup).catch(() => {});
});

describe('storage.objects RLS — must be denied', () => {
  test('anonymous listing of another booking\'s documents is denied (no SELECT policy exists at all)', async () => {
    const { data, error } = await anon.storage.from(BUCKET).list(EXISTING_BOOKING_ID);
    // Supabase Storage's list() over a path with no matching SELECT policy
    // returns an empty array, not an error - assert emptiness, not a thrown error.
    assert.ok(!error, error?.message);
    assert.deepEqual(data, [], 'anon must not be able to list an existing booking\'s document folder');
  });

  test('anonymous download of another booking\'s document is denied', async () => {
    const { data, error } = await anon.storage.from(BUCKET).download(EXISTING_DOC_PATH);
    assert.ok(error, 'expected anon download of an existing booking\'s document to be rejected');
    assert.equal(data, null);
  });

  test('anonymous upload into an existing booking\'s own folder is denied (path restricted to temp/ only)', async () => {
    const { error } = await anon.storage.from(BUCKET)
      .upload(`${EXISTING_BOOKING_ID}/planted-by-anon.pdf`, Buffer.from('%PDF-1.4 planted'), { contentType: 'application/pdf' });
    assert.ok(error, 'expected anon upload outside temp/ to be rejected');
  });

  test('anonymous overwrite of an existing document is denied (no UPDATE policy, upsert path)', async () => {
    const { error } = await anon.storage.from(BUCKET)
      .upload(EXISTING_DOC_PATH, Buffer.from('%PDF-1.4 overwritten'), { contentType: 'application/pdf', upsert: true });
    assert.ok(error, 'expected anon overwrite of an existing document to be rejected');

    // Confirm the original content survived, not just that an error was thrown.
    const { data: stillOriginal } = await service.storage.from(BUCKET).download(EXISTING_DOC_PATH);
    const text = await stillOriginal.text();
    assert.equal(text, EXISTING_DOC_CONTENT, 'the existing document must be byte-for-byte unchanged after the denied overwrite attempt');
  });

  test('anonymous upload of a disallowed file extension into temp/ is denied', async () => {
    const { error } = await anon.storage.from(BUCKET)
      .upload(`temp/${TEMP_UUID}/wrong-extension.txt`, Buffer.from('not a real document'), { contentType: 'text/plain' });
    assert.ok(error, 'expected a non-pdf/jpg/jpeg/png upload to be rejected even inside temp/');
  });

  test('cross-organisation document access is denied (same mechanism as the general SELECT denial — no org-scoped bypass exists)', async () => {
    const { data, error } = await anon.storage.from(BUCKET).list('');
    assert.ok(!error, error?.message);
    assert.deepEqual(data, [], 'anon must not be able to list the bucket root, across any organisation\'s bookings');
  });
});

describe('storage.objects RLS — must continue working', () => {
  test('anonymous upload into temp/ with a legitimate pdf/jpg/jpeg/png under 5MB succeeds (the real public-booking-form flow)', async () => {
    const { error } = await anon.storage.from(BUCKET)
      .upload(`temp/${TEMP_UUID}/legit-upload.pdf`, Buffer.from('%PDF-1.4 legitimate temp upload'), { contentType: 'application/pdf', upsert: false });
    assert.equal(error, null, `expected the real public-booking-form upload shape to succeed: ${error?.message}`);
  });

  test('service_role can still read, move, and manage documents (get-booking-documents / submit-booking\'s own path)', async () => {
    const { data, error } = await service.storage.from(BUCKET).download(EXISTING_DOC_PATH);
    assert.equal(error, null, `service_role must be unaffected by anon-scoped RLS: ${error?.message}`);
    assert.equal(await data.text(), EXISTING_DOC_CONTENT);

    // Mirrors submit-booking's own move() call - service_role, unaffected by
    // RLS. Self-contained: uploads its own temp file rather than depending
    // on another test's leftover state.
    const movedFrom = `temp/${TEMP_UUID}/service-role-move-source.pdf`;
    const movedTo = `${EXISTING_BOOKING_ID}/moved-by-service-role.pdf`;
    pathsToCleanup.push(movedFrom, movedTo);
    const { error: seedErr } = await service.storage.from(BUCKET)
      .upload(movedFrom, Buffer.from('%PDF-1.4 to be moved'), { contentType: 'application/pdf' });
    assert.equal(seedErr, null, `fixture upload for the move test failed: ${seedErr?.message}`);

    const { error: moveErr } = await service.storage.from(BUCKET).move(movedFrom, movedTo);
    assert.equal(moveErr, null, `service_role move must be unaffected by RLS: ${moveErr?.message}`);

    const { data: signed, error: signErr } = await service.storage.from(BUCKET).createSignedUrl(movedTo, 60);
    assert.equal(signErr, null, `service_role signed-URL generation must be unaffected: ${signErr?.message}`);
    assert.ok(signed.signedUrl, 'expected a real signed URL');
  });
});
