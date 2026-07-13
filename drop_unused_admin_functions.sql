-- ===================================================================
-- FIX: remove unused/duplicate admin-check functions
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- check_user_is_admin(), is_admin(), and is_admin_safe() were verified
-- to have zero references anywhere in the database before this was
-- written: not in any RLS policy (checked via pg_policies), not called
-- from any other function (checked via pg_get_functiondef across all
-- of public), and not called from any trigger (checked via pg_trigger).
-- Only check_user_role() and get_is_admin() are actually in use, and
-- they serve different call shapes (parameterized role-check used by
-- 6 policies, vs. a parameterless bool-check used by 1), so there's
-- nothing to merge between them — deleting the three unused functions
-- is the fix, not consolidating.
--
-- Dropped by looking up the exact signature dynamically, since the
-- precise argument list wasn't re-verified here — this avoids a wrong
-- guess at the signature causing a "function does not exist" error.
-- ===================================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('check_user_is_admin', 'is_admin', 'is_admin_safe')
  LOOP
    EXECUTE format('DROP FUNCTION %s', r.sig);
  END LOOP;
END $$;

-- ===================================================================
-- VERIFY:
--   SELECT proname FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN ('check_user_is_admin', 'is_admin', 'is_admin_safe');
--   -- Should return 0 rows.
-- ===================================================================
