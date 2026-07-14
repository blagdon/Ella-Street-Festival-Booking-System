-- Storage buckets and storage.objects RLS policies.
--
-- Deliberately separate from the public-schema baseline
-- (20260714132316_baseline_schema.sql) — the `storage` schema itself is
-- platform-managed by Supabase (schema creation, internal types like
-- storage.buckettype, the buckets/objects table definitions) and a
-- migration has no permission to recreate any of that; an earlier attempt
-- to include the full `storage` schema in a migration failed with
-- "permission denied for schema storage" on exactly that internal setup.
-- This file only contains the parts that are actually ours: the three
-- bucket definitions and the one RLS policy on storage.objects, both
-- verified against the live project as of 2026-07-14.

INSERT INTO storage.buckets (id, name, public, avif_autodetection, file_size_limit, allowed_mime_types, type)
VALUES
  ('documents', 'documents', false, false, 10485760, NULL, 'STANDARD'),
  ('performer-documents', 'performer-documents', false, false, 5242880,
    '{application/pdf,image/jpeg,image/png,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document}',
    'STANDARD'),
  ('esf-documents', 'esf-documents', false, false, 12582912,
    '{image/jpeg,image/png,application/pdf}',
    'STANDARD')
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Public booking forms upload directly to esf-documents with the anon key
-- (js/page-food-booking.js etc.) — this is the only anon-facing write path
-- left on any of the three buckets; documents/performer-documents' anon
-- policies were dropped entirely this session (see
-- fix_documents_bucket_object_policies.sql) since that bucket is dead, and
-- esf-documents reads go through get-booking-documents using the service
-- role, which bypasses RLS, so no SELECT policy is needed here either.
DROP POLICY IF EXISTS "Strict Public Uploads" ON storage.objects;
CREATE POLICY "Strict Public Uploads" ON storage.objects
FOR INSERT WITH CHECK (
  (bucket_id = 'esf-documents'::text)
  AND (
    (storage.extension(name) = 'pdf'::text)
    OR (storage.extension(name) = 'jpg'::text)
    OR (storage.extension(name) = 'jpeg'::text)
    OR (storage.extension(name) = 'png'::text)
  )
  AND CASE
    WHEN ((metadata ->> 'size'::text) IS NOT NULL) THEN (((metadata ->> 'size'::text))::integer <= 5242880)
    ELSE true
  END
);
