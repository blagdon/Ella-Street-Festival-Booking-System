-- ===================================================================
-- BACKFILL: convert bookings.documents from public URLs to storage paths
-- Run this AFTER deploying the updated submit-booking and
-- get-booking-documents Edge Functions, and BEFORE running
-- fix_esf_documents_bucket_private.sql.
--
-- submit-booking now stores a bare storage path (e.g.
-- "ESF26-FOOD-0042/1234_photo.jpg") in bookings.documents instead of a
-- full public URL, because esf-documents is being migrated to a private
-- bucket — paths are resolved to a signed URL on demand by the new
-- get-booking-documents Edge Function. Existing rows still hold the old
-- full public URLs (e.g.
-- "https://rsnxhuhibglieofikkpo.supabase.co/storage/v1/object/public/esf-documents/ESF26-FOOD-0042/1234_photo.jpg"),
-- which js/shared.js's populateDetailPane() will keep rendering directly
-- as-is (it detects legacy full URLs vs bare paths) — but converting them
-- now means everything goes through the one signed-URL code path once
-- esf-documents actually goes private, rather than depending on this
-- fallback indefinitely.
--
-- Idempotent: the regexp_replace only matches strings containing the
-- public-URL prefix, so re-running this after paths are already bare is
-- a no-op.
-- ===================================================================

UPDATE bookings
SET documents = (
  SELECT array_agg(regexp_replace(doc, '^.*/storage/v1/object/public/esf-documents/', ''))
  FROM unnest(documents) AS doc
)
WHERE documents IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM unnest(documents) AS doc
    WHERE doc LIKE '%/storage/v1/object/public/esf-documents/%'
  );

-- ===================================================================
-- VERIFY:
--   SELECT id, documents FROM bookings WHERE documents IS NOT NULL;
--   -- every element should now be a bare "{booking_id}/{filename}" path,
--   -- not a "https://.../storage/v1/object/public/..." URL.
-- ===================================================================
