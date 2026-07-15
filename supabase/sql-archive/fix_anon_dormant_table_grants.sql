-- ===================================================================
-- FIX: revoke dormant DELETE/TRUNCATE/MAINTAIN grants from anon
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- A schema audit (prompted by a third-party review of anon RLS
-- exposure) found that `bookings` and `performers` both still grant
-- anon table-level DELETE, TRUNCATE, and MAINTAIN privileges — left
-- over from before the column-scoped SELECT grants and the INSERT/
-- UPDATE/REFERENCES revokes in fix_bookings_rls_exposure.sql and
-- fix_performer_schedule_column_grants.sql. Those two files revoked
-- INSERT/UPDATE/REFERENCES but didn't touch DELETE/TRUNCATE/MAINTAIN.
--
-- NOT CURRENTLY EXPLOITABLE: DELETE and TRUNCATE/MAINTAIN aren't
-- column-scoped in Postgres, and no RLS policy on either table grants
-- anon a DELETE command at all (confirmed via pg_policies — every anon
-- policy on both tables is SELECT or INSERT only), so RLS's
-- default-deny blocks any anon DELETE/TRUNCATE regardless of the
-- grant. Revoking removes the same class of risk already addressed
-- for INSERT/UPDATE: a future policy change (e.g. an "ALL" policy
-- added for some new anon-facing feature) would otherwise silently
-- inherit these grants and become exploitable immediately.
-- ===================================================================

REVOKE DELETE, TRUNCATE, MAINTAIN ON public.bookings FROM anon;
REVOKE DELETE, TRUNCATE, MAINTAIN ON public.performers FROM anon;

-- ===================================================================
-- VERIFY:
--   SELECT table_name, privilege_type
--   FROM information_schema.table_privileges
--   WHERE table_schema = 'public' AND table_name IN ('bookings', 'performers')
--     AND grantee = 'anon' AND privilege_type IN ('DELETE', 'TRUNCATE', 'MAINTAIN');
--   -- should return 0 rows.
-- ===================================================================
