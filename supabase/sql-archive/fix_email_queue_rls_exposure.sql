-- ===================================================================
-- HARDEN email_queue TABLE — remove redundant unrestricted policy
-- Already applied directly in the Supabase SQL Editor; recorded here
-- as a historical record of the change.
--
-- A review of pg_policies on `email_queue` found two policies: a
-- properly-scoped "Admin manage email" (gated on check_user_role
-- ('admin')), and a second, redundant policy with no role check at all,
-- granting full read/write access on every row to any request. Every
-- legitimate write path (the admin UI's send-email flow, and the
-- submit-booking Edge Function's own log entry) already goes through
-- either the authenticated admin client or the service role key, so the
-- unrestricted policy served no purpose.
-- ===================================================================

DROP POLICY IF EXISTS "auth_manage_email_queue" ON email_queue;

-- Defense in depth: remove any underlying table-level grants for anon
-- too — there is no legitimate anon use case for this table.
REVOKE ALL ON email_queue FROM anon;

-- ===================================================================
-- VERIFY:
--   SELECT policyname, roles, cmd, qual, with_check FROM pg_policies WHERE tablename = 'email_queue';
--   -- Only "Admin manage email" should remain.
--   SELECT grantee, privilege_type FROM information_schema.table_privileges
--   WHERE table_name = 'email_queue' AND grantee = 'anon';
--   -- Should return no rows.
-- ===================================================================
