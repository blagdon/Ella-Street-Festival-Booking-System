-- Migration: 20260806010000_tenant_scope_organisation_members_event_settings.sql
-- Found while re-running the Launch Readiness Review after 20260806000000 to
-- confirm that sweep was actually exhaustive, not just five tables done: a
-- full query of every RLS policy still referencing check_user_role() or a
-- raw user_roles EXISTS check found two more real gaps.
--
-- organisation_members itself ("Admins can manage organisation_members" /
-- "Admins can read organisation_members") still gated purely on
-- check_user_role('admin'), with no org_id correlation - any organisation's
-- admin could already read or write ANY other organisation's membership
-- roster (who's an admin/steward, and could add/remove members from an org
-- they have nothing to do with). Arguably more sensitive than the five
-- tables in 20260806000000, since it's the access-control table itself.
--
-- event_settings ("Allow admins full access to event_settings") used a raw
-- EXISTS(user_roles WHERE role='admin') check with no correlation to which
-- event - and no org_id column of its own to correlate directly, so this
-- follows booking_locations' join pattern from 20260805040000 instead: the
-- correlated read is safe because event_settings' own policy is what's
-- being replaced, and events' own RLS is unaffected by reading its org_id
-- here.
--
-- performers/schedules also still use a raw user_roles EXISTS check
-- (performer_admin_access, schedule_admin_access) but are deliberately left
-- alone - per HANDOVER.md, this is a genuinely separate, single-tenant
-- feature with no org_id column at all, not an unswept instance of the
-- multi-tenant pattern. user_roles' own "policy_allow_all_admin" is also
-- left alone for the same reason: it is the legacy global table by design,
-- not org-scoped data.

-- ---------------------------------------------------------------------
-- organisation_members
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can manage organisation_members" ON "public"."organisation_members";
DROP POLICY IF EXISTS "Admins can read organisation_members" ON "public"."organisation_members";

CREATE POLICY "Admins can manage own org organisation_members" ON "public"."organisation_members"
    FOR ALL TO "authenticated"
    USING ("public"."is_platform_admin"() OR "public"."has_org_role"("organisation_members"."org_id", ARRAY['admin']))
    WITH CHECK ("public"."is_platform_admin"() OR "public"."has_org_role"("organisation_members"."org_id", ARRAY['admin']));

-- ---------------------------------------------------------------------
-- event_settings (no org_id of its own - correlated via its parent event,
-- same reasoning as booking_locations' policies in 20260805040000)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Allow admins full access to event_settings" ON "public"."event_settings";

CREATE POLICY "Admins can manage own org event_settings" ON "public"."event_settings"
    FOR ALL TO "authenticated"
    USING (
        "public"."is_platform_admin"()
        OR EXISTS (
            SELECT 1 FROM "public"."events" e
            WHERE e."id" = "event_settings"."event_id"
              AND "public"."has_org_role"(e."org_id", ARRAY['admin'])
        )
    )
    WITH CHECK (
        "public"."is_platform_admin"()
        OR EXISTS (
            SELECT 1 FROM "public"."events" e
            WHERE e."id" = "event_settings"."event_id"
              AND "public"."has_org_role"(e."org_id", ARRAY['admin'])
        )
    );
