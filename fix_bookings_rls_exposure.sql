-- ===================================================================
-- HARDEN bookings TABLE — anon role privilege cleanup
-- Already applied directly in the Supabase SQL Editor; recorded here
-- as a historical record of the change.
--
-- A review of pg_policies / column_privileges on `bookings` found the
-- anon role had broader access than any part of the app actually uses:
-- unrestricted SELECT across all columns, an authenticated-read policy
-- with no role check (unlike the admin/steward policies, which do
-- check), and full INSERT/UPDATE privileges that nothing relies on —
-- every public write goes through the submit-booking Edge Function,
-- which uses the service role key and bypasses table-level grants
-- entirely.
--
-- This script locks anon down to exactly what's needed: read access to
-- a small set of non-sensitive columns for the public visitor map,
-- nothing else.
-- ===================================================================

-- 1. Restrict anon SELECT to the columns the public map actually needs.
REVOKE SELECT ON bookings FROM anon;
GRANT SELECT (id, business_name, description, stall_type, category, instance_prefix) ON bookings TO anon;

-- 2. Remove an authenticated-read policy that had no role check
--    (redundant with the existing admin/steward policies).
DROP POLICY IF EXISTS "Staff can view bookings" ON bookings;

-- 3. Remove anon INSERT/UPDATE/REFERENCES — confirmed unused.
REVOKE INSERT, UPDATE, REFERENCES ON bookings FROM anon;
DROP POLICY IF EXISTS "anon_insert_bookings" ON bookings;

-- ===================================================================
-- VERIFY:
--   SELECT policyname, roles, cmd, qual FROM pg_policies WHERE tablename = 'bookings';
--   SELECT grantee, privilege_type, column_name
--   FROM information_schema.column_privileges
--   WHERE table_name = 'bookings' AND grantee = 'anon';
--   -- anon should show only SELECT on the 6 columns above.
-- ===================================================================
