-- Migration: 20260813140000_e5_23_explicit_org_invite_membership.sql
-- E5-23 (expanded scope) — rpc_add_organisation_member resolved its target
-- organisation ambiently via get_current_org_id(), not from an explicit
-- caller-supplied parameter. get_current_org_id() falls back through a JWT
-- claim this deployment never populates, then an organisation_members
-- lookup for the CALLER's own account - which does not necessarily match
-- the organisation a platform admin has selected via the UI's org-switcher
-- (ctx.orgId in js/page-admin.js, computed but never transmitted to this
-- RPC). A platform admin inviting a member to Organisation B could
-- therefore have that membership silently created in a different
-- organisation than the one shown in the UI. This also blocked a correct
-- fix for the original E5-23 finding (invite-organisation-member's
-- hardcoded invite-link base URL): there was no reliable way to know which
-- organisation's own base_url setting to look up.
--
-- Fix: require an explicit p_org_id parameter, authorised via the same
-- is_authorised_for_org(p_org_id, ARRAY['admin']) primitive already used by
-- rpc_initialise_tenant_defaults and the six RPCs fixed under Decision 4
-- (20260806030000/20260807060000) - is_platform_admin() OR
-- has_org_role(p_org_id, ...), checked against the TARGET organisation, not
-- the caller's ambient session. Returns the authoritative org_id used, so
-- invite-organisation-member can resolve that exact organisation's own
-- base_url rather than re-deriving org context a second time.
--
-- Changing the signature (adding a parameter) doesn't replace the old
-- overload in place - CREATE OR REPLACE only matches on identical argument
-- types, so the original rpc_add_organisation_member(text, text) would
-- otherwise keep existing alongside this one, leaving the ambient-org path
-- callable. Drop it explicitly first - same pattern already used in
-- 20260805030000_provision_display_name_override.sql for
-- rpc_initialise_tenant_defaults(text) -> (text, text).
--
-- get_current_org_id(), is_platform_admin(), has_org_role(), and
-- is_authorised_for_org() are unchanged by this migration.
--
-- Revised before commit: invite-organisation-member originally discovered a
-- target org's missing base_url AFTER this RPC had already committed the
-- membership - a genuinely new invitee's user_roles/organisation_members
-- rows existed even though no invite could be (or was) sent. This RPC
-- already determines, via its own existing auth.users lookup, whether an
-- invitee is genuinely new (no real login yet) - the exact fact that
-- decides whether an invite will be needed at all. Reusing that fact here,
-- rather than re-deriving it a second time in the Edge Function or checking
-- base_url from there, gets true atomicity for free: an unhandled
-- RAISE EXCEPTION anywhere before this plpgsql function returns rolls back
-- every statement it already ran in this same call, including both
-- INSERTs, with no compensating DELETE required or possible to race. The
-- check only establishes that a base_url row exists for p_org_id (never
-- its value, never org_default, never get_current_org_id()) - resolving
-- and using the actual URL remains entirely invite-organisation-member's
-- job, unchanged.

DROP FUNCTION IF EXISTS "public"."rpc_add_organisation_member"(text, text);

CREATE OR REPLACE FUNCTION "public"."rpc_add_organisation_member"(
    "p_org_id" text,
    "p_email" text,
    "p_role" text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid;
    v_role_enum user_role;
    v_is_new_invitee boolean;
BEGIN
    IF p_org_id IS NULL OR trim(p_org_id) = '' THEN
        RAISE EXCEPTION 'Organisation ID is required';
    END IF;

    -- Authorised against the explicit target organisation, not the
    -- caller's ambient session - the target org is the protected
    -- resource. Merely naming org_default here confers no special
    -- privilege: it is checked by has_org_role() like any other org_id,
    -- so a non-member cannot add themselves by supplying it.
    IF NOT is_authorised_for_org(p_org_id, ARRAY['admin']) THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required';
    END IF;

    IF p_email IS NULL OR trim(p_email) = '' THEN
        RAISE EXCEPTION 'User email address is required';
    END IF;

    IF p_role NOT IN ('admin', 'steward') THEN
        RAISE EXCEPTION 'Invalid role: %', p_role;
    END IF;

    v_role_enum := p_role::user_role;

    SELECT id INTO v_user_id
    FROM auth.users
    WHERE lower(email) = lower(trim(p_email))
    LIMIT 1;

    -- Genuinely new = no real login exists yet - exactly the condition
    -- under which invite-organisation-member will need to send an invite
    -- email, so it is exactly the condition that needs a usable base_url.
    v_is_new_invitee := (v_user_id IS NULL);

    IF v_user_id IS NULL THEN
        SELECT id INTO v_user_id
        FROM public.user_roles
        WHERE lower(email) = lower(trim(p_email))
        LIMIT 1;
    END IF;

    IF v_user_id IS NULL THEN
        v_user_id := gen_random_uuid();
    END IF;

    IF v_is_new_invitee THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.settings
            WHERE org_id = p_org_id AND key = 'base_url' AND trim(value) <> ''
        ) THEN
            -- Existence only - never the value itself, and never checked
            -- against org_default or get_current_org_id(). Raising here,
            -- before either INSERT below runs, rolls back nothing (nothing
            -- has been written yet) rather than relying on rollback of
            -- already-executed statements - simpler to reason about, same
            -- guarantee.
            RAISE EXCEPTION 'Organisation is not configured to invite new members';
        END IF;
    END IF;

    INSERT INTO public.user_roles (id, email, role)
    VALUES (v_user_id, lower(trim(p_email)), v_role_enum)
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, email = EXCLUDED.email;

    INSERT INTO public.organisation_members (org_id, user_id, role)
    VALUES (p_org_id, v_user_id, p_role)
    ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role;

    RETURN jsonb_build_object(
        'status', 'success',
        'org_id', p_org_id,
        'user_id', v_user_id,
        'email', lower(trim(p_email)),
        'role', p_role,
        'is_new_invitee', v_is_new_invitee
    );
END;
$$;

GRANT EXECUTE ON FUNCTION "public"."rpc_add_organisation_member"(text, text, text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."rpc_add_organisation_member"(text, text, text) TO "service_role";
