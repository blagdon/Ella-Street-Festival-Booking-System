-- Migration: 20260805000000_membership_scope_org_visibility.sql
-- RC operational certification, Finding 6 — the org switcher (js/nav.js)
-- and the RLS policies backing it let any authenticated admin see every
-- organisation's existence, name, slug, and website, regardless of whether
-- they actually belonged to it. Three separate policies all granted this,
-- redundantly:
--   "Admins can manage organisations" (FOR ALL, so implicitly SELECT too)
--   "Admins can read organisations"   (FOR SELECT)
--   "Users can read own organisation" (FOR SELECT, "own org OR admin")
-- Postgres RLS policies are OR'd together, so tightening only the last one
-- (the one actually quoted in the finding) would have left the leak fully
-- intact via the other two - all three needed the same fix.
--
-- Genuine platform administrators (global user_roles.admin) still need a
-- way to browse every organisation: the "View As" / org-switching workflow
-- this whole review relied on, and admin write operations like editing
-- another org's details. That capability now goes through
-- rpc_list_switchable_organisations() explicitly and is labelled in the UI
-- (js/nav.js's orgScopeBadge), rather than living as an implicit,
-- unlabelled RLS bypass.
--
-- While rewriting the write-side policy, testing surfaced a second, more
-- severe pre-existing issue in the same policy: "Admins can manage
-- organisations" gated on check_user_role('admin') alone, which does NOT
-- correlate to the specific organisations row being written - its primary
-- check is organisation_members scoped to get_current_org_id() (whatever
-- org happens to be active in the caller's session), so ANY org-scoped
-- admin of ANY single organisation could already update or delete ANY
-- OTHER organisation's row, not just their own. Confirmed live: a test
-- user who was only an admin member of one throwaway org successfully
-- renamed org_default through this policy. Fixed here alongside the read
-- leak since it's the exact same root cause (check_user_role('admin')
-- used somewhere that needs to distinguish "genuine platform admin" from
-- "admin of the currently-active org") and the same policies were already
-- being rewritten.

-- 1. Small reusable helper: true only for a genuine global user_roles.admin
--    row, never for an org-scoped organisation_members admin. Deliberately
--    separate from check_user_role(), whose primary check IS org-scoped and
--    therefore answers a different question than "is this a platform-wide
--    admin, regardless of which org is currently active".
CREATE OR REPLACE FUNCTION "public"."is_platform_admin"()
RETURNS boolean
LANGUAGE "sql" STABLE SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
    SELECT EXISTS (
        SELECT 1 FROM "public"."user_roles"
        WHERE "id" = "auth"."uid"() AND "role" = 'admin'::"public"."user_role"
    );
$$;

-- 2. Drop the two fully-redundant SELECT-granting policies.
DROP POLICY IF EXISTS "Admins can read organisations" ON "public"."organisations";

-- 3. Split "Admins can manage organisations" into per-command policies, so
--    platform admins keep full write/manage capability but stop implicitly
--    getting blanket SELECT through it (FOR ALL with no command list covers
--    SELECT too) - and so UPDATE specifically can also allow an org's own
--    admin to edit their own organisation's details (the "Organisation" tab
--    in js/page-admin.js), correctly correlated to that specific row,
--    without reopening the "any org admin can write any org" hole above.
--    INSERT/DELETE stay platform-admin-only: creating/deleting an
--    organisation isn't a self-service action for an org's own admin, and
--    real provisioning goes through the service-role Edge Function anyway
--    (which bypasses RLS entirely, so this policy only gates the
--    authenticated-client path).
DROP POLICY IF EXISTS "Admins can manage organisations" ON "public"."organisations";
DROP POLICY IF EXISTS "Admins can insert organisations" ON "public"."organisations";
CREATE POLICY "Admins can insert organisations" ON "public"."organisations"
    FOR INSERT TO "authenticated"
    WITH CHECK ("public"."is_platform_admin"());
DROP POLICY IF EXISTS "Admins can update organisations" ON "public"."organisations";
CREATE POLICY "Admins can update organisations" ON "public"."organisations"
    FOR UPDATE TO "authenticated"
    USING (
        "public"."is_platform_admin"()
        OR EXISTS (
            SELECT 1 FROM "public"."organisation_members"
            WHERE "organisation_members"."org_id" = "organisations"."id"
              AND "organisation_members"."user_id" = "auth"."uid"()
              AND "organisation_members"."role" = 'admin'
        )
    )
    WITH CHECK (
        "public"."is_platform_admin"()
        OR EXISTS (
            SELECT 1 FROM "public"."organisation_members"
            WHERE "organisation_members"."org_id" = "organisations"."id"
              AND "organisation_members"."user_id" = "auth"."uid"()
              AND "organisation_members"."role" = 'admin'
        )
    );
DROP POLICY IF EXISTS "Admins can delete organisations" ON "public"."organisations";
CREATE POLICY "Admins can delete organisations" ON "public"."organisations"
    FOR DELETE TO "authenticated"
    USING ("public"."is_platform_admin"());

-- 4. Tighten the remaining SELECT policy to real membership instead of a
--    blanket admin bypass.
DROP POLICY IF EXISTS "Users can read own organisation" ON "public"."organisations";
CREATE POLICY "Users can read own organisation" ON "public"."organisations"
    FOR SELECT TO "authenticated"
    USING (
        ("id" = "public"."get_current_org_id"())
        OR EXISTS (
            SELECT 1 FROM "public"."organisation_members"
            WHERE "organisation_members"."org_id" = "organisations"."id"
              AND "organisation_members"."user_id" = "auth"."uid"()
        )
    );

-- 5. The explicit, labelled "see everything" path for platform admins.
--    SECURITY DEFINER (owned by postgres, same as check_user_role() and
--    every other cross-tenant RPC in this schema) so it can read every
--    organisation regardless of the tightened policy above.
CREATE OR REPLACE FUNCTION "public"."rpc_list_switchable_organisations"()
RETURNS "jsonb"
LANGUAGE "plpgsql" STABLE SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
DECLARE
    v_is_platform_admin boolean := "public"."is_platform_admin"();
    v_orgs jsonb;
BEGIN
    IF v_is_platform_admin THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug) ORDER BY o.name), '[]'::jsonb)
        INTO v_orgs
        FROM "public"."organisations" o;
    ELSE
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug) ORDER BY o.name), '[]'::jsonb)
        INTO v_orgs
        FROM "public"."organisations" o
        JOIN "public"."organisation_members" m ON m."org_id" = o."id"
        WHERE m."user_id" = "auth"."uid"();
    END IF;

    RETURN jsonb_build_object(
        'scope', CASE WHEN v_is_platform_admin THEN 'platform_admin' ELSE 'member' END,
        'organisations', v_orgs
    );
END;
$$;

GRANT EXECUTE ON FUNCTION "public"."is_platform_admin"() TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."rpc_list_switchable_organisations"() TO "authenticated";
