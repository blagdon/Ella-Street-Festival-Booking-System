-- Migration: 20260805040000_tenant_scope_bookings_locations_events_templates.sql
-- Launch Readiness Review, Must-Fix Findings 1, 2 and (part of) 4 — several
-- tables' admin RLS policies check only check_user_role('admin') or a direct
-- user_roles lookup, with no correlation between the row's own org_id and
-- the caller's actual organisation. check_user_role()'s documented fallback
-- to the global user_roles table (kept for Phase 1 backwards compatibility -
-- see 20260801003_create_organisation_members.sql) means ANY organisation's
-- owner, who always receives a global user_roles admin row during
-- provisioning, already satisfies these policies regardless of which
-- organisation a given row belongs to. Confirmed by reading the live
-- deployed policy text and check_user_role()'s body directly, not by
-- inspecting migration source.
--
-- Six tables share this exact defect: bookings, locations, events,
-- booking_locations, email_templates, sms_templates. This migration aligns
-- all of them with the pattern already proven correct for organisations and
-- settings (20260805000000_membership_scope_org_visibility.sql,
-- 20260805010000_membership_scope_settings_writes.sql): is_platform_admin()
-- as the explicit, labelled bypass, otherwise a real per-row organisation
-- membership check.
--
-- events also had three overlapping SELECT-capable policies (the same shape
-- organisations had before its own fix) - "Admins can manage events" (FOR
-- ALL) and "Admins can read events" (FOR SELECT) both granted an unscoped
-- bypass that made the third policy's org_id correlation meaningless, since
-- permissive policies OR together. All three are replaced with per-command
-- policies below, the same restructuring organisations already went through.
--
-- Every membership check below goes through has_org_role() rather than an
-- inline EXISTS against organisation_members directly. This is not stylistic:
-- organisation_members' own SELECT policy ("Admins can read organisation_members",
-- USING check_user_role('admin')) only allows admins to read it at all — an
-- inline subquery runs as the CALLING role, so a steward's own subquery
-- would be silently filtered to nothing by organisation_members' own RLS
-- before the outer policy ever saw a result, even though the steward's row
-- genuinely exists. check_user_role() and is_platform_admin() already avoid
-- this by being SECURITY DEFINER; has_org_role() below is the same fix,
-- generalised to an explicit role list instead of a single hard-coded
-- 'admin'. Caught by tests/privilege-hardening.test.mjs's existing steward
-- read-access test failing against the first version of this migration —
-- proof this needs to be a real, executed regression test, not just a read
-- of the policy SQL.
CREATE OR REPLACE FUNCTION "public"."has_org_role"("p_org_id" text, "p_roles" text[])
RETURNS boolean
LANGUAGE "sql" STABLE SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
    SELECT EXISTS (
        SELECT 1 FROM "public"."organisation_members"
        WHERE "org_id" = p_org_id
          AND "user_id" = "auth"."uid"()
          AND "role" = ANY(p_roles)
    );
$$;

GRANT EXECUTE ON FUNCTION "public"."has_org_role"(text, text[]) TO "authenticated";

-- ---------------------------------------------------------------------
-- bookings
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Admin full" ON "public"."bookings";
DROP POLICY IF EXISTS "Steward access" ON "public"."bookings";

CREATE POLICY "Admins can manage own org bookings" ON "public"."bookings"
    FOR ALL TO "authenticated"
    USING ("public"."is_platform_admin"() OR "public"."has_org_role"("bookings"."org_id", ARRAY['admin']))
    WITH CHECK ("public"."is_platform_admin"() OR "public"."has_org_role"("bookings"."org_id", ARRAY['admin']));

CREATE POLICY "Staff can read own org bookings" ON "public"."bookings"
    FOR SELECT TO "authenticated"
    USING ("public"."is_platform_admin"() OR "public"."has_org_role"("bookings"."org_id", ARRAY['admin', 'steward']));

-- ---------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can manage events" ON "public"."events";
DROP POLICY IF EXISTS "Admins can read events" ON "public"."events";
DROP POLICY IF EXISTS "Users can read own events" ON "public"."events";

CREATE POLICY "Admins can insert events" ON "public"."events"
    FOR INSERT TO "authenticated"
    WITH CHECK ("public"."is_platform_admin"() OR "public"."has_org_role"("events"."org_id", ARRAY['admin']));

CREATE POLICY "Admins can update events" ON "public"."events"
    FOR UPDATE TO "authenticated"
    USING ("public"."is_platform_admin"() OR "public"."has_org_role"("events"."org_id", ARRAY['admin']))
    WITH CHECK ("public"."is_platform_admin"() OR "public"."has_org_role"("events"."org_id", ARRAY['admin']));

CREATE POLICY "Admins can delete events" ON "public"."events"
    FOR DELETE TO "authenticated"
    USING ("public"."is_platform_admin"() OR "public"."has_org_role"("events"."org_id", ARRAY['admin']));

CREATE POLICY "Members can read own org events" ON "public"."events"
    FOR SELECT TO "authenticated"
    USING ("public"."is_platform_admin"() OR "public"."has_org_role"("events"."org_id", ARRAY['admin', 'steward']));

-- ---------------------------------------------------------------------
-- locations (admin write side only here - public read side is handled
-- below by retiring direct anon table access in favour of a scoped RPC,
-- since RLS alone cannot express "anon may read organisation X's live
-- locations" without something to correlate the request to X in the first
-- place)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Admin manage locations" ON "public"."locations";

CREATE POLICY "Admins can manage own org locations" ON "public"."locations"
    FOR ALL TO "authenticated"
    USING ("public"."is_platform_admin"() OR "public"."has_org_role"("locations"."org_id", ARRAY['admin']))
    WITH CHECK ("public"."is_platform_admin"() OR "public"."has_org_role"("locations"."org_id", ARRAY['admin']));

-- js/page-steward.js reads locations directly (dataset='LIVE', for the
-- offline-sync pitch list) as an authenticated steward, not just an admin -
-- the admin-only policy above would otherwise silently break that workflow.
CREATE POLICY "Staff can read own org locations" ON "public"."locations"
    FOR SELECT TO "authenticated"
    USING ("public"."is_platform_admin"() OR "public"."has_org_role"("locations"."org_id", ARRAY['admin', 'steward']));

-- Finding 2: "Public view locations" (dataset = 'LIVE', no org_id at all)
-- let anyone read every organisation's live location layout in one
-- unfiltered query - not "knows org X's link" (the public map is meant to be
-- reachable that way, same as the public booking forms), but "can enumerate
-- every organisation's data with no org_id supplied at all". RLS has no way
-- to correlate an anonymous request to "the one organisation this visitor is
-- legitimately looking at" - only the caller's own supplied org_id could do
-- that, and a policy cannot trust a value it doesn't itself constrain.
-- Removing anon's direct read entirely and requiring org_id + dataset
-- through a SECURITY DEFINER RPC mirrors the one pattern already proven for
-- exactly this shape of problem in this codebase: storage.objects has no
-- anon SELECT policy at all, every read goes through a controlled
-- server-side function instead.
DROP POLICY IF EXISTS "Public view locations" ON "public"."locations";
REVOKE SELECT ON TABLE "public"."locations" FROM "anon";

CREATE OR REPLACE FUNCTION "public"."rpc_get_public_locations"("p_org_id" text, "p_dataset" text)
RETURNS SETOF "public"."locations"
LANGUAGE "sql" STABLE SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
    SELECT * FROM "public"."locations"
    WHERE "org_id" = p_org_id AND "dataset" = p_dataset;
$$;

GRANT EXECUTE ON FUNCTION "public"."rpc_get_public_locations"(text, text) TO "anon", "authenticated";

-- ---------------------------------------------------------------------
-- booking_locations (join table - no org_id column of its own, correlated
-- via its parent booking's org_id instead)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Allow admins full access to booking_locations" ON "public"."booking_locations";
DROP POLICY IF EXISTS "Allow staff to read booking_locations" ON "public"."booking_locations";

-- has_org_role() takes a single org_id, but booking_locations only knows its
-- org through the parent booking, so this join stays inline (SECURITY
-- DEFINER on has_org_role() only fixes the organisation_members recursion,
-- not the need to look up bookings.org_id first) - but the read on
-- `bookings` here is safe: bookings' own RLS separately protects it, and
-- reading just org_id to resolve a role check leaks nothing PII-shaped even
-- if it were visible.
CREATE POLICY "Admins can manage own org booking_locations" ON "public"."booking_locations"
    FOR ALL TO "authenticated"
    USING (
        "public"."is_platform_admin"()
        OR EXISTS (
            SELECT 1 FROM "public"."bookings" b
            WHERE b."id" = "booking_locations"."booking_id"
              AND "public"."has_org_role"(b."org_id", ARRAY['admin'])
        )
    )
    WITH CHECK (
        "public"."is_platform_admin"()
        OR EXISTS (
            SELECT 1 FROM "public"."bookings" b
            WHERE b."id" = "booking_locations"."booking_id"
              AND "public"."has_org_role"(b."org_id", ARRAY['admin'])
        )
    );

CREATE POLICY "Staff can read own org booking_locations" ON "public"."booking_locations"
    FOR SELECT TO "authenticated"
    USING (
        "public"."is_platform_admin"()
        OR EXISTS (
            SELECT 1 FROM "public"."bookings" b
            WHERE b."id" = "booking_locations"."booking_id"
              AND "public"."has_org_role"(b."org_id", ARRAY['admin', 'steward'])
        )
    );

-- "Allow public anon to read confirmed booking locations" (is_booking_confirmed(booking_id))
-- is left untouched: it is already scoped to one specific, known booking id,
-- not enumerable across organisations the way the two policies above were.

-- ---------------------------------------------------------------------
-- email_templates / sms_templates
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Admin manage email_templates" ON "public"."email_templates";

CREATE POLICY "Admins can manage own org email_templates" ON "public"."email_templates"
    FOR ALL TO "authenticated"
    USING ("public"."is_platform_admin"() OR "public"."has_org_role"("email_templates"."org_id", ARRAY['admin']))
    WITH CHECK ("public"."is_platform_admin"() OR "public"."has_org_role"("email_templates"."org_id", ARRAY['admin']));

DROP POLICY IF EXISTS "Admin manage sms_templates" ON "public"."sms_templates";

CREATE POLICY "Admins can manage own org sms_templates" ON "public"."sms_templates"
    FOR ALL TO "authenticated"
    USING ("public"."is_platform_admin"() OR "public"."has_org_role"("sms_templates"."org_id", ARRAY['admin']))
    WITH CHECK ("public"."is_platform_admin"() OR "public"."has_org_role"("sms_templates"."org_id", ARRAY['admin']));
