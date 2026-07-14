-- ===================================================================
-- FIX: make esf-documents private
-- Run this LAST, only after all of the following are true:
--   1. The updated submit-booking and get-booking-documents Edge
--      Functions are deployed live.
--   2. backfill_booking_document_paths.sql has been run and verified.
--   3. You've confirmed a booking's documents open correctly from
--      kanban_m.html / summary.html (signed-URL path working end to end).
--
-- esf-documents was public=true, so every uploaded booking document
-- (ID photos, insurance certs, etc.) was readable via an unauthenticated
-- URL. The app now resolves documents to time-limited signed URLs for
-- authenticated admins only (get-booking-documents Edge Function), so
-- public read access is no longer needed — this closes it off.
--
-- Running this before the code/backfill steps above will break the
-- existing document links in the admin UI (they'd still be stored as
-- full public URLs pointing at a now-private bucket, returning 400).
-- ===================================================================

UPDATE storage.buckets SET public = false WHERE id = 'esf-documents';

-- ===================================================================
-- VERIFY:
--   SELECT id, public FROM storage.buckets WHERE id = 'esf-documents';
--   -- should show public = false.
--   Then open a booking with existing documents in kanban_m.html and
--   confirm "Open Document" links still work.
-- ===================================================================
