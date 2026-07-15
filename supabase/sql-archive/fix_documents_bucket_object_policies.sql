-- ===================================================================
-- FIX: drop anon/authenticated access policies on the documents bucket
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- Two storage.objects RLS policies still let any anon (or authenticated)
-- caller INSERT arbitrary files (no type/size restriction beyond the
-- bucket's blanket 10MB limit — the policy's "JPG images" name is
-- misleading, it checks nothing about file type) into
-- documents/performer-insurance/, and SELECT (list + download) anything
-- already there:
--   "Give anon users access to JPG images in folder flreew_0"  (INSERT)
--   "Performer insurance downloads flreew_0"                   (SELECT)
--
-- documents/performer-insurance/ has had no upload since 2026-02-16.
-- The separate performer-application app (ellafestperformersadmin.vercel.app)
-- moved to the performer-documents bucket days later — that bucket has a
-- proper allowed_mime_types restriction and uploads as recent as
-- 2026-06-21, confirming it's the one actually in live use. These two
-- policies are the only storage.objects policies referencing the
-- `documents` bucket at all, so dropping them fully closes off a bucket
-- nothing has used in 5 months, without touching the live upload path.
-- (This is in addition to fix_orphaned_bucket_public_exposure.sql, which
-- already set the bucket's public flag to false — that alone didn't stop
-- anon uploading/listing via the Storage API using the anon key, which
-- goes through these RLS policies independently of the public flag.)
-- ===================================================================

DROP POLICY "Give anon users access to JPG images in folder flreew_0" ON storage.objects;
DROP POLICY "Performer insurance downloads flreew_0" ON storage.objects;

-- ===================================================================
-- VERIFY:
--   SELECT policyname, roles, cmd FROM pg_policies
--   WHERE schemaname = 'storage' AND tablename = 'objects' AND qual LIKE '%documents%';
--   -- should return 0 rows (no policy left referencing the documents bucket).
-- ===================================================================
