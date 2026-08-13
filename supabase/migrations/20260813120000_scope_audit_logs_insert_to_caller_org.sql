-- Migration: 20260813120000_scope_audit_logs_insert_to_caller_org.sql
-- E5-22 (Epic 5 closing architecture review) — audit_logs INSERT has been
-- WITH CHECK (true) since the baseline schema. The read side was scoped in
-- 20260806000000, with the INSERT side deliberately left open on the
-- reasoning that "every real writer already supplies a correct org_id."
-- That reasoning describes the trusted js/audit.js helper's own behaviour,
-- not the actual enforcement boundary: audit_logs is directly reachable
-- through PostgREST by any authenticated session, so RLS — not the helper —
-- is what has to reject a forged row. Under WITH CHECK (true), any
-- authenticated user, any role, any organisation (a steward included) can
-- currently insert an audit_logs row with an arbitrary org_id, action,
-- target_id, and details, fabricating a plausible-looking entry attributed
-- to another organisation's investigation trail. Only user_email is already
-- safe (stamp_audit_log_user_email overwrites it from the JWT claim,
-- 20260720100100).
--
-- Investigation before this fix (full writer inventory):
--   - js/audit.js's auditLog() — the only frontend writer, called from 17
--     files across both admin- and steward-facing pages. Confirmed
--     js/page-steward.js calls it directly for real, legitimate actions
--     ('steward_location_change', 'steward_location_change_sync') using the
--     default org_id (the steward's own current org) — so unlike
--     bookings/payments/hcc_checks (admin-only ALL policies), stewards
--     genuinely need real INSERT authority here, not just admins. This
--     mirrors the existing ARRAY['admin','steward'] precedent already used
--     for staff-level writes elsewhere (bookings/locations/events RLS in
--     20260805040000, and rpc_set_booking_locations's own check in
--     20260807060000) — not a new role shape invented for this fix.
--   - Every Edge Function writer (create-checkout-session, provision-
--     organisation) uses a service-role client, which bypasses RLS
--     entirely — unaffected by this policy either way, confirmed by
--     re-reading both call sites.
--   - No writer anywhere was found that legitimately targets an
--     organisation other than the caller's own, except a genuine platform
--     admin operating in "switch organisation" mode — already covered by
--     is_authorised_for_org()'s own is_platform_admin() branch, same as
--     every other tenant-scoped table.
--
-- Fix: reuse is_authorised_for_org() (20260807060000) — the same shared
-- helper the RPC layer already consolidated onto — rather than inlining a
-- new check or duplicating an authorization framework in the policy body.
-- Deliberately NOT check_user_role(): that function is scoped to the
-- caller's own get_current_org_id() (ambient context, with a legacy
-- user_roles fallback), not to the specific org_id a given row claims to
-- belong to — using it here would re-open exactly the "any org's admin
-- passes" shape every other Epic 5 fix closed. is_authorised_for_org()
-- checks has_org_role() against the row's own org_id directly, which is
-- the property this fix actually needs.
--
-- event_id is intentionally not part of this check: the architecture
-- review's finding was specifically about tenant (org) identity, and
-- widening scope to a second dimension is exactly what this fix's own
-- task brief rules out.

DROP POLICY IF EXISTS "Allow authenticated users to insert audit logs" ON "public"."audit_logs";

CREATE POLICY "Staff can insert own org audit_logs" ON "public"."audit_logs"
    FOR INSERT TO "authenticated"
    WITH CHECK ("public"."is_authorised_for_org"("audit_logs"."org_id", ARRAY['admin', 'steward']));
