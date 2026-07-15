-- ===================================================================
-- FIX: policies scoped to {authenticated} with no role check
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- Context: public self-signup is enabled on this project (Auth ->
-- Sign In / Providers -> "Allow new users to sign up"). That means
-- "authenticated" is not a trust boundary on its own — anyone can
-- create an account with a disposable email. Every policy below is
-- scoped to {authenticated} with `USING (true)` and no role check,
-- despite several being named as if they were admin-only. Each is
-- replaced with a version that actually checks user_roles.
-- ===================================================================

-- 1. booking_locations — was granting SELECT on every row (not just
--    Confirmed bookings) to any authenticated account. Admin/steward
--    both need this (steward.js reads it directly), so replace with a
--    role-gated version rather than dropping it outright.
DROP POLICY IF EXISTS "Allow authenticated read access to booking_locations" ON booking_locations;
CREATE POLICY "Allow staff to read booking_locations"
ON booking_locations FOR SELECT TO authenticated
USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_roles.id = auth.uid() AND user_roles.role IN ('admin', 'steward'))
);

-- 2. email_templates — three separate ungated policies replaced with
--    one admin-only ALL policy, matching the convention used on
--    settings/payments/locations elsewhere in this project.
DROP POLICY IF EXISTS "Admins can update templates" ON email_templates;
DROP POLICY IF EXISTS "Admins can insert templates" ON email_templates;
DROP POLICY IF EXISTS "Admins can view templates" ON email_templates;
CREATE POLICY "Admin manage email_templates"
ON email_templates FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM user_roles WHERE user_roles.id = auth.uid() AND user_roles.role = 'admin'))
WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_roles.id = auth.uid() AND user_roles.role = 'admin'));

-- 3. hcc_checks — drop the ungated duplicate; "Admins manage hcc_checks"
--    (already correctly gated on check_user_role('admin')) remains.
DROP POLICY IF EXISTS "Admin Full Access" ON hcc_checks;

-- 4. location_power — replace the ungated admin-write policy. Leaves
--    "Public view power" (anon+authenticated SELECT) untouched, since
--    that one is presumably intentional public read access.
DROP POLICY IF EXISTS "Admins manage power" ON location_power;
CREATE POLICY "Admin manage location_power"
ON location_power FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM user_roles WHERE user_roles.id = auth.uid() AND user_roles.role = 'admin'))
WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_roles.id = auth.uid() AND user_roles.role = 'admin'));

-- 5. user_roles — the ungated SELECT policy let anyone enumerate the
--    entire admin/steward directory. Cannot just drop it: js/supabase.js's
--    requireAuth() does `select('role').eq('id', session.user.id)` on
--    every login to check the *current user's own* role, so replace
--    with a self-scoped policy instead of removing read access outright.
DROP POLICY IF EXISTS "policy_allow_select_authenticated" ON user_roles;
CREATE POLICY "Users can read own role"
ON user_roles FOR SELECT TO authenticated
USING (id = auth.uid());

-- ===================================================================
-- VERIFY:
--   SELECT tablename, policyname, roles, cmd, qual, with_check
--   FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename;
--
-- Then re-test:
--   - Log in as admin and steward — both should still work normally.
--   - Location Manager: assign/remove locations (booking_locations read).
--   - Settings page: view/edit email templates.
--   - HCC Checks page.
--   - Any location power-related feature.
-- ===================================================================
