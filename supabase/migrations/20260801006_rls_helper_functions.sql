-- Migration: 20260801006_rls_helper_functions.sql
-- Phase 1 — Platform Foundation: Step 7
--
-- Creates tenant-resolution helper functions as Phase 1 stubs.
-- Both return constant values — no tenant switching exists yet.
--
-- Why create them now?
--   Phase 2 RLS policy updates call these functions to resolve the current
--   tenant/event. By establishing them as stubs in Phase 1, Phase 2 policy
--   updates need only change the function body — not every individual RLS
--   policy definition. This is the "thin seam" approach: the surface that
--   changes in Phase 2 is minimal and localised.
--
-- IMPORTANT — do NOT call these from any RPC or RLS policy until Phase 2.
--   The functions are stubs and always return 'org_default'/'event_default'.
--   Adding them to policies now would have no practical effect but would
--   create misleading noise in the RLS snapshot diff. They are created here
--   for schema completeness only.
--
-- Backwards compatibility guarantee:
--   No existing RLS policy or RPC is altered by this migration.

CREATE OR REPLACE FUNCTION "public"."get_current_org_id"()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
    -- Phase 1 stub: single-tenant deployment, always returns org_default.
    -- Phase 2: derive from the user's JWT claims (custom claim set during
    -- sign-in) or from an organisation_members lookup on auth.uid().
    -- The function signature and name are intentionally stable so that
    -- Phase 2 RLS policy updates only change this body.
    SELECT 'org_default'::text;
$$;

CREATE OR REPLACE FUNCTION "public"."get_current_event_id"()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
    -- Phase 1 stub: single-event deployment, always returns event_default.
    -- Phase 2: derive from the user's active event selection, stored in
    -- a JWT custom claim or a user-preferences lookup.
    -- NOTE: this returns the events.id, not the instance_prefix.
    -- The instance_prefix to event_id migration is Phase 2. See §6.1.
    SELECT 'event_default'::text;
$$;

COMMENT ON FUNCTION "public"."get_current_org_id"() IS
    'Returns the organisation ID for the current request context. '
    'Phase 1 stub: always returns org_default. '
    'Phase 2: real tenant resolution from JWT claims or organisation_members. '
    'Do not add to RLS policies or RPCs until Phase 2 switches this to real logic.';

COMMENT ON FUNCTION "public"."get_current_event_id"() IS
    'Returns the event ID for the current request context. '
    'Phase 1 stub: always returns event_default. '
    'Phase 2: real event resolution from JWT claims or user session. '
    'Returns events.id, not instance_prefix — see implementation_plan.md §3.1.';

-- Restrict to authenticated sessions and service_role (Edge Functions).
-- Anon does not need tenant resolution in Phase 1 (and should not have it).
REVOKE ALL ON FUNCTION "public"."get_current_org_id"()   FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."get_current_event_id"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."get_current_org_id"()   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION "public"."get_current_event_id"() TO authenticated, service_role;
