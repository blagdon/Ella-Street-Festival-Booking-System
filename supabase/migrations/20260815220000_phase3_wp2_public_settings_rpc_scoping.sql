-- Migration: 20260815220000_phase3_wp2_public_settings_rpc_scoping.sql
-- Multi-Event Architecture Phase 3 — WP2: Public Settings RLS Scoping
--
-- Problem (architectural review): the anon-read RLS policies on `settings`
-- and `event_settings` filter ONLY by an allow-listed `key` — there is no
-- `org_id`/`event_id` predicate at all. Every legitimate caller in this
-- codebase already scopes its own query by org_id/event_id (confirmed by
-- re-reading js/public-context.js and supabase-public.js in full), so the
-- gap is invisible in normal use — but a single unfiltered call, e.g.
-- `anon.from('settings').select('org_id,key,value').in('key', ALLOWLIST)`,
-- returns EVERY organisation's rows for those keys at once today. None of
-- the 24 allow-listed keys are secrets, but several are business-sensitive
-- (stall costs, regulatory authority name, insurance minimum amount) and
-- were never meant to be platform-wide scrapable in one request.
--
-- Why a plain RLS predicate can't fix this: a row policy conditions on the
-- ROW's own columns, not on whether the caller's query happened to include
-- an org_id filter. There is no way to write `USING (...)` that blocks an
-- unfiltered scan while allowing a filtered one — every row already
-- satisfies "key is in the allow-list" regardless of how the caller phrases
-- their WHERE clause. Only a function whose SIGNATURE requires exactly one
-- org_id/event_id can structurally cap a single call to one tenant — hence
-- the SECURITY DEFINER RPC approach below, mirroring the existing
-- rpc_get_public_locations(p_org_id, p_dataset) pattern
-- (20260805040000_tenant_scope_bookings_locations_events_templates.sql)
-- rather than inventing a new shape.
--
-- The 24-key allow-list itself is unchanged — every key was already
-- reviewed as legitimately public-per-org; this migration only changes HOW
-- that data is reached, not WHAT is reachable.
--
-- No data migration. No change to the org-level-settings-then-event-level-
-- override precedence model (unchanged in application code). No change to
-- authenticated/admin settings access (those policies are untouched).

-- ---------------------------------------------------------------------
-- rpc_get_public_settings — replaces anon's direct SELECT on `settings`.
-- Returns only the existing 24 allow-listed keys, for exactly the one
-- p_org_id supplied. Mirrors rpc_get_public_locations's shape: STABLE SQL
-- function, explicit search_path, schema-qualified table, the parameter
-- used only as a bind value in a WHERE clause (never concatenated into
-- SQL text), so there is no injection surface and no way for a single call
-- to span more than one organisation.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."rpc_get_public_settings"("p_org_id" text)
RETURNS TABLE("key" text, "value" text)
LANGUAGE "sql" STABLE SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
    SELECT "key", "value"
    FROM "public"."settings"
    WHERE "org_id" = p_org_id
      AND "key" = ANY (ARRAY[
        'stall_cost_food', 'stall_cost_general', 'stall_cost_dev',
        'turnstile_site_key', 'base_url', 'cancel_url', 'portal_url',
        'booking_prefix', 'bucket_name', 'hcc_council_email',
        'map_center_lat', 'map_center_lng', 'map_default_zoom',
        'food_bookings_open', 'general_bookings_open',
        'sentry_browser_loader_url',
        'brand_primary_color', 'brand_accent_color',
        'logo_url', 'logo_light_url',
        'org_support_email', 'email_footer_text',
        'regulatory_authority_name', 'insurance_minimum_amount'
      ]::text[]);
$$;

REVOKE ALL ON FUNCTION "public"."rpc_get_public_settings"("p_org_id" text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."rpc_get_public_settings"("p_org_id" text) TO "anon";
GRANT EXECUTE ON FUNCTION "public"."rpc_get_public_settings"("p_org_id" text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."rpc_get_public_settings"("p_org_id" text) TO "service_role";

-- ---------------------------------------------------------------------
-- rpc_get_public_event_settings — identical shape, event_settings/event_id.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."rpc_get_public_event_settings"("p_event_id" text)
RETURNS TABLE("key" text, "value" text)
LANGUAGE "sql" STABLE SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
    SELECT "key", "value"
    FROM "public"."event_settings"
    WHERE "event_id" = p_event_id
      AND "key" = ANY (ARRAY[
        'stall_cost_food', 'stall_cost_general', 'stall_cost_dev',
        'turnstile_site_key', 'base_url', 'cancel_url', 'portal_url',
        'booking_prefix', 'bucket_name', 'hcc_council_email',
        'map_center_lat', 'map_center_lng', 'map_default_zoom',
        'food_bookings_open', 'general_bookings_open',
        'sentry_browser_loader_url',
        'brand_primary_color', 'brand_accent_color',
        'logo_url', 'logo_light_url',
        'org_support_email', 'email_footer_text',
        'regulatory_authority_name', 'insurance_minimum_amount'
      ]::text[]);
$$;

REVOKE ALL ON FUNCTION "public"."rpc_get_public_event_settings"("p_event_id" text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."rpc_get_public_event_settings"("p_event_id" text) TO "anon";
GRANT EXECUTE ON FUNCTION "public"."rpc_get_public_event_settings"("p_event_id" text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."rpc_get_public_event_settings"("p_event_id" text) TO "service_role";

-- ---------------------------------------------------------------------
-- Close the base-table gap: anon can no longer SELECT settings/
-- event_settings directly at all. Authenticated-role policies/grants for
-- both tables are untouched by this migration.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Allow public anon to read non-sensitive settings" ON "public"."settings";
DROP POLICY IF EXISTS "Allow public anon to read non-sensitive event_settings" ON "public"."event_settings";

REVOKE SELECT ON TABLE "public"."settings" FROM "anon";
REVOKE SELECT ON TABLE "public"."event_settings" FROM "anon";
