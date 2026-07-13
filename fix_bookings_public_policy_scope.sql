-- ===================================================================
-- FIX: scope "Public see confirmed" to anon only
-- Already applied directly in the Supabase SQL Editor; recorded here
-- as a historical record of the change.
--
-- This policy was always intended for the public visitor map (anon
-- access to Confirmed bookings), but was created without a TO clause,
-- so it also applied to the authenticated role. Admin/steward don't
-- need it — they already have full access via their own properly
-- role-gated policies (Admin full / Steward access) — so for them it
-- was pure redundant overreach: any authenticated account (not just
-- admin/steward) could read every column of every Confirmed booking.
-- Scoping it to anon removes that overreach; anon's own access is
-- unaffected since it's already independently column-restricted via
-- an earlier fix (see fix_bookings_rls_exposure.sql).
-- ===================================================================

DROP POLICY IF EXISTS "Public see confirmed" ON bookings;
CREATE POLICY "Public see confirmed"
ON bookings FOR SELECT TO anon
USING (status = 'Confirmed');

-- ===================================================================
-- VERIFY:
--   SELECT policyname, roles, cmd, qual FROM pg_policies WHERE tablename = 'bookings';
--   -- "Public see confirmed" should now show roles = {anon}.
-- ===================================================================
