-- ===================================================================
-- FIX: mass-assignment gap in the public performer application form,
-- plus dormant excess write-grants on performers/schedules
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- LIVE ISSUE: performers' "Public can apply" policy allows anon INSERT
-- with no WITH CHECK, and anon already has column-level INSERT grants
-- on every column (confirmed via information_schema.column_privileges)
-- — including status, total_cost, amount_paid, insurance_verified,
-- admin_notes, payment_notes, deleted_at. A caller hitting the
-- Supabase REST API directly (bypassing https://ellafestperformersadmin.vercel.app/public/apply.html
-- entirely) could insert a performer row already marked 'Paid' with a
-- forged amount_paid/insurance_verified, skipping admin review. Fixed
-- by adding a WITH CHECK that pins every non-applicant-supplied column
-- to its safe default, and by revoking INSERT access to those columns
-- outright so they can't be set even if the WITH CHECK is ever loosened.
--
-- HYGIENE (not currently exploitable): anon also holds UPDATE/REFERENCES
-- grants on every column of both tables, and blanket INSERT/UPDATE
-- grants on schedules — none of these do anything today, since no RLS
-- policy grants anon UPDATE on performers, or INSERT/UPDATE on
-- schedules at all (confirmed via pg_policies), so RLS's default-deny
-- blocks them regardless. Revoking removes the risk that a future
-- policy change (e.g. accidentally widening "Public can apply" to ALL)
-- would silently inherit these grants and become exploitable.
--
-- Both tables' SELECT-side column grants for anon were checked and are
-- already correctly scoped (safe display columns only) — untouched here.
-- authenticated's grants are untouched — its access is already scoped
-- per-row by existing policies (own application via email match, or
-- full admin access via user_roles) and covers real logged-in humans,
-- not the general public.
-- ===================================================================

-- performers: remove anon's ability to write to admin/payment/system columns
REVOKE INSERT, UPDATE, REFERENCES ON public.performers FROM anon;

GRANT INSERT (
  name, email, phone, address, description,
  performance_type, performance_type_other, cost_per_30min, power_needed,
  insurance_file_url, insurance_file_name
) ON public.performers TO anon;

DROP POLICY IF EXISTS "Public can apply" ON public.performers;
CREATE POLICY "Public can apply"
ON public.performers FOR INSERT TO anon, authenticated
WITH CHECK (
  status = 'Applied'::performer_status
  AND total_cost = 0
  AND amount_paid = 0
  AND insurance_verified = false
  AND insurance_verified_at IS NULL
  AND insurance_verified_by IS NULL
  AND status_updated_at IS NULL
  AND status_updated_by IS NULL
  AND admin_notes IS NULL
  AND payment_notes IS NULL
  AND deleted_at IS NULL
);

-- schedules: no anon write policy exists at all — remove the unused grants
REVOKE INSERT, UPDATE, REFERENCES ON public.schedules FROM anon;

-- ===================================================================
-- VERIFY:
--   SELECT grantee, column_name, privilege_type
--   FROM information_schema.column_privileges
--   WHERE table_schema = 'public' AND table_name IN ('performers', 'schedules')
--     AND grantee = 'anon' AND privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES');
--   -- performers should show INSERT only, only on the 11 applicant-supplied
--   -- columns listed above. schedules should return 0 rows.
--
--   SELECT policyname, cmd, with_check FROM pg_policies
--   WHERE schemaname = 'public' AND tablename = 'performers' AND policyname = 'Public can apply';
--   -- with_check should show the new conditions.
-- ===================================================================
