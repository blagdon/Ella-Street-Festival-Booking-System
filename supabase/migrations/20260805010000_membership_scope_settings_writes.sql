-- Migration: 20260805010000_membership_scope_settings_writes.sql
-- RC operational certification, Finding 10 — "Allow admins full access to
-- settings" gated every command (it's FOR ALL, no explicit command list) on
-- a genuine global user_roles.admin row alone, with no correlation to the
-- specific organisation the row belongs to. Unlike organisations' Finding 6
-- policies, this one didn't have the "any org-scoped admin can reach every
-- org" bug (it already checked user_roles directly, not the org-scoped
-- check_user_role()) - but it also meant an ordinary organisation's own
-- admin could never read or write their OWN settings via RLS at all
-- (js/settings/*.js's org_id scoping, added for the Finding 2 fix, is what
-- actually made per-org settings work in practice; the database itself
-- never granted it). No customer-visible impact today because of that
-- client-side scoping, but the database was one missing client check away
-- from either blocking every org admin outright or (if the client ever
-- omitted org_id again, as Finding 2 already showed can happen) not
-- actually being the thing stopping a cross-tenant write.
--
-- Same fix as Finding 6, mirrored onto settings: split into per-command
-- policies, each allowing a genuine platform admin (is_platform_admin(),
-- added in the previous migration) OR an organisation's own admin member
-- (correlated to that specific settings.org_id, not just "some org" the
-- caller happens to belong to).

DROP POLICY IF EXISTS "Allow admins full access to settings" ON "public"."settings";

DROP POLICY IF EXISTS "Admins can read settings" ON "public"."settings";
CREATE POLICY "Admins can read settings" ON "public"."settings"
    FOR SELECT TO "authenticated"
    USING (
        "public"."is_platform_admin"()
        OR EXISTS (
            SELECT 1 FROM "public"."organisation_members"
            WHERE "organisation_members"."org_id" = "settings"."org_id"
              AND "organisation_members"."user_id" = "auth"."uid"()
              AND "organisation_members"."role" = 'admin'
        )
    );

DROP POLICY IF EXISTS "Admins can insert settings" ON "public"."settings";
CREATE POLICY "Admins can insert settings" ON "public"."settings"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        "public"."is_platform_admin"()
        OR EXISTS (
            SELECT 1 FROM "public"."organisation_members"
            WHERE "organisation_members"."org_id" = "settings"."org_id"
              AND "organisation_members"."user_id" = "auth"."uid"()
              AND "organisation_members"."role" = 'admin'
        )
    );

DROP POLICY IF EXISTS "Admins can update settings" ON "public"."settings";
CREATE POLICY "Admins can update settings" ON "public"."settings"
    FOR UPDATE TO "authenticated"
    USING (
        "public"."is_platform_admin"()
        OR EXISTS (
            SELECT 1 FROM "public"."organisation_members"
            WHERE "organisation_members"."org_id" = "settings"."org_id"
              AND "organisation_members"."user_id" = "auth"."uid"()
              AND "organisation_members"."role" = 'admin'
        )
    )
    WITH CHECK (
        "public"."is_platform_admin"()
        OR EXISTS (
            SELECT 1 FROM "public"."organisation_members"
            WHERE "organisation_members"."org_id" = "settings"."org_id"
              AND "organisation_members"."user_id" = "auth"."uid"()
              AND "organisation_members"."role" = 'admin'
        )
    );

DROP POLICY IF EXISTS "Admins can delete settings" ON "public"."settings";
CREATE POLICY "Admins can delete settings" ON "public"."settings"
    FOR DELETE TO "authenticated"
    USING (
        "public"."is_platform_admin"()
        OR EXISTS (
            SELECT 1 FROM "public"."organisation_members"
            WHERE "organisation_members"."org_id" = "settings"."org_id"
              AND "organisation_members"."user_id" = "auth"."uid"()
              AND "organisation_members"."role" = 'admin'
        )
    );
