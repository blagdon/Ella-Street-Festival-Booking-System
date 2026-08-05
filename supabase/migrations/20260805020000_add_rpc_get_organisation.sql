-- Migration: 20260805020000_add_rpc_get_organisation.sql
-- Round 2 operational certification, Finding 1 — the Organisation Settings
-- tab in js/page-admin.js still does a direct
-- `organisations.select('*').eq('id', ctx.orgId)`. The last certification's
-- own RLS fix (20260805000000_membership_scope_org_visibility.sql, Finding 6)
-- correctly removed platform admins' blanket SELECT bypass on this table and
-- routed the org-switcher through a new, labelled
-- rpc_list_switchable_organisations() instead — but this page's detail/edit
-- form was never migrated to use it, so that same direct select now silently
-- returns zero rows under RLS for any organisation the admin isn't a member
-- of (which is every org they didn't personally provision under their own
-- account). Confirmed live: the request succeeds with an empty array, no
-- error, and the page's own fallback logic then substitutes hardcoded
-- placeholder values with nothing to indicate they aren't real — and the
-- Save button on the same page can then write those placeholders over the
-- organisation's real row, since the UPDATE policy still allows a platform
-- admin's write regardless of membership.
--
-- Fix: the same explicit, labelled-RPC pattern Finding 6 already established
-- for "platform admin needs to see something membership alone wouldn't
-- allow" — rather than reopening the blanket SELECT bypass that fix
-- deliberately closed. This RPC returns one organisation's full row when the
-- caller is a genuine platform admin OR an actual member of that
-- organisation, and NULL otherwise (never an error, so the caller can
-- distinguish "not found/not allowed" from a real fetch failure the same way
-- .maybeSingle() already does elsewhere in this codebase).

CREATE OR REPLACE FUNCTION "public"."rpc_get_organisation"("p_org_id" text)
RETURNS "jsonb"
LANGUAGE "plpgsql" STABLE SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
DECLARE
    v_org jsonb;
BEGIN
    IF NOT (
        "public"."is_platform_admin"()
        OR EXISTS (
            SELECT 1 FROM "public"."organisation_members"
            WHERE "organisation_members"."org_id" = p_org_id
              AND "organisation_members"."user_id" = "auth"."uid"()
        )
    ) THEN
        RETURN NULL;
    END IF;

    SELECT to_jsonb(o) INTO v_org
    FROM "public"."organisations" o
    WHERE o.id = p_org_id;

    RETURN v_org;
END;
$$;

GRANT EXECUTE ON FUNCTION "public"."rpc_get_organisation"(text) TO "authenticated";
