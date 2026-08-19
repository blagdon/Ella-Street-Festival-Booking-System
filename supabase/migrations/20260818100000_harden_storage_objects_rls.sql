-- Migration: 20260818100000_harden_storage_objects_rls.sql
-- Storage RLS hardening (Phase 1 of the post-checkpoint security work).
--
-- Investigation summary: `storage.buckets` correctly has `public = false` on
-- all three document buckets (esf-documents, documents, performer-documents),
-- but `storage.objects` RLS — a separate, independent gate — did not match
-- that intent. Findings, confirmed by direct inspection of both live
-- environments (never written to, read-only throughout):
--
--   TEST project currently has 11 accumulated storage.objects policies
--   granting `public`/`anon` unrestricted SELECT and, for esf-documents,
--   INSERT/UPDATE with no path scoping at all — effectively bypassing the
--   bucket's own private flag entirely for that project.
--
--   PRODUCTION currently has exactly ONE policy on storage.objects
--   ("Strict Public Uploads": anon INSERT on esf-documents only, restricted
--   by extension/size but NOT by path) — already far more locked down than
--   test (matching HANDOVER.md's own account of prior one-off sql-archive
--   hardening scripts that were applied there but never mirrored to test).
--   Even so, production's one surviving policy has no path restriction, so
--   an anonymous caller could still plant a new file (not overwrite one —
--   no anon UPDATE policy exists) at an arbitrary path inside the private
--   bucket, including inside an existing booking's own folder.
--
-- Application code was traced exhaustively (every `.storage.from(...)` call
-- site in js/ and supabase/functions/, confirmed via full-repo grep — no
-- other call sites exist beyond the three below):
--   1. js/page-food-booking.js / js/page-general-booking.js — the two public
--      booking forms upload attachments, via the anon client, BEFORE the
--      booking exists, to `temp/<tempUuid>/<fileName>` in esf-documents
--      (`upsert: false` — the app itself never wants an overwrite here).
--      This is the one genuine anonymous-write requirement in the whole
--      system.
--   2. supabase/functions/submit-booking/index.ts — after the booking insert
--      succeeds, moves each file server-side (service_role, bypasses RLS
--      entirely — no policy needed) from `temp/<tempUuid>/<fileName>` to
--      `<bookingId>/<fileName>`, the permanent, booking-scoped path.
--   3. supabase/functions/get-booking-documents/index.ts — the only reader,
--      also service_role, org-scoped at the query level before it ever
--      touches Storage, generating short-lived signed URLs. Confirmed no
--      anon/authenticated SELECT policy is needed for any legitimate flow:
--      nothing in the app ever reads a document via a raw table/API call.
--
-- documents/performer-documents: confirmed via full-repo grep that no file
-- in this codebase references either bucket at all — HANDOVER.md documents
-- that both are used exclusively by a separate, external application
-- (ellafestperformersadmin.vercel.app) which does not depend on any anon
-- RLS policy here (production already has zero policies for either bucket
-- and that separate app's uploads continue unaffected). The two dead
-- `documents`-bucket policies present only on test (no upload since
-- 2026-02-16, per HANDOVER.md) are dropped here too, bringing test in line
-- with production's already-correct state for both buckets.
--
-- Result: exactly one policy survives across all three buckets — anon
-- INSERT into esf-documents, now also restricted to the temp/ staging
-- prefix in addition to the existing extension/size limits. No anon/public
-- SELECT, UPDATE, or DELETE exists anywhere. service_role is unaffected (it
-- already bypasses RLS entirely, platform-wide, needing no policy of its
-- own) — the move/signed-URL paths above continue working unchanged.

-- ---------------------------------------------------------------------
-- 1. Drop every known legacy/accumulated policy by name (IF EXISTS is
--    safe regardless of which subset exists on a given environment).
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Allow Public Downloads" ON storage.objects;
DROP POLICY IF EXISTS "Allow Public Uploads" ON storage.objects;
DROP POLICY IF EXISTS "Give anon users access to JPG images in folder flreew_0" ON storage.objects;
DROP POLICY IF EXISTS "Performer insurance downloads flreew_0" ON storage.objects;
DROP POLICY IF EXISTS "Public Access: Insert" ON storage.objects;
DROP POLICY IF EXISTS "Public Access: Select" ON storage.objects;
DROP POLICY IF EXISTS "Public Access: Update" ON storage.objects;
DROP POLICY IF EXISTS "Public Access: View" ON storage.objects;
DROP POLICY IF EXISTS "Public Select performer-documents" ON storage.objects;
DROP POLICY IF EXISTS "Public Upload performer-documents" ON storage.objects;
DROP POLICY IF EXISTS "Strict Public Uploads" ON storage.objects;

-- ---------------------------------------------------------------------
-- 2. The one policy the application genuinely needs: anonymous upload
--    into esf-documents' temp/ staging prefix only, matching the
--    extension/size limits already enforced client-side
--    (js/page-food-booking.js, js/page-general-booking.js).
-- ---------------------------------------------------------------------
CREATE POLICY "Anon can upload to esf-documents temp staging only"
ON storage.objects
FOR INSERT
TO public
WITH CHECK (
    bucket_id = 'esf-documents'
    AND (storage.foldername(name))[1] = 'temp'
    AND storage.extension(name) = ANY (ARRAY['pdf', 'jpg', 'jpeg', 'png'])
    AND (
        (metadata ->> 'size') IS NULL
        OR ((metadata ->> 'size')::integer <= 5242880)
    )
);
