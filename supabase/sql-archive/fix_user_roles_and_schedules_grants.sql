-- ===================================================================
-- FIX: tighten dormant grants on user_roles and schedules
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- user_roles backs every admin/steward permission check in the app
-- (check_user_role(), get_is_admin()) — its own RLS is the single point
-- of trust the whole system leans on. That RLS is correctly configured
-- today: both policies ("Users can read own role", "policy_allow_all_admin")
-- are scoped TO authenticated only, and writes require get_is_admin().
-- anon has no matching policy at all, so RLS default-denies it completely.
-- But the table still carried a blanket GRANT ALL to both anon and
-- authenticated — including TRUNCATE, MAINTAIN, and REFERENCES, none of
-- which the app ever uses (js/page-manage-users.js only does
-- select/delete/upsert). TRUNCATE specifically is never gated by RLS in
-- Postgres regardless of policy, so this is the same class of dormant-
-- grant landmine already fixed for bookings/performers in
-- fix_anon_dormant_table_grants.sql — not reachable via the app's
-- current PostgREST/RPC surface, but would be inherited for free by any
-- future custom function or script using either role's credentials.
--
-- schedules had the identical leftover on anon (DELETE, TRUNCATE,
-- MAINTAIN) that was missed by fix_anon_dormant_table_grants.sql, which
-- only covered bookings and performers. anon's legitimate SELECT access
-- to schedules ("Public row-level access for schedules" policy) is
-- untouched — only the unused write/maintenance privileges are revoked,
-- same scope as the earlier fix (TRIGGER is deliberately left alone
-- there too, matching that precedent).
-- ===================================================================

-- anon has no RLS policy on user_roles at all — it needs no grant whatsoever.
REVOKE ALL ON public.user_roles FROM anon;

-- authenticated only ever needs SELECT/INSERT/UPDATE/DELETE (gated by RLS);
-- TRUNCATE/MAINTAIN/REFERENCES/TRIGGER are unused and TRUNCATE bypasses RLS entirely.
REVOKE TRUNCATE, MAINTAIN, REFERENCES, TRIGGER ON public.user_roles FROM authenticated;

-- Same dormant-grant cleanup already applied to bookings/performers, missed for schedules.
REVOKE DELETE, TRUNCATE, MAINTAIN ON public.schedules FROM anon;

-- ===================================================================
-- VERIFY:
--   SELECT grantee, privilege_type FROM information_schema.table_privileges
--   WHERE table_schema = 'public' AND table_name = 'user_roles' AND grantee = 'anon';
--   -- should return 0 rows.
--
--   SELECT grantee, privilege_type FROM information_schema.table_privileges
--   WHERE table_schema = 'public' AND table_name = 'user_roles' AND grantee = 'authenticated';
--   -- should show only SELECT, INSERT, UPDATE, DELETE.
--
--   SELECT grantee, privilege_type FROM information_schema.table_privileges
--   WHERE table_schema = 'public' AND table_name = 'schedules' AND grantee = 'anon'
--     AND privilege_type IN ('DELETE', 'TRUNCATE', 'MAINTAIN');
--   -- should return 0 rows.
-- ===================================================================
