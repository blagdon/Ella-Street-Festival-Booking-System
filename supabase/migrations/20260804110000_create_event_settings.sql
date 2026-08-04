-- Migration: 20260804110000_create_event_settings.sql
-- Epic 4, Phase 4B — Event Configuration
--
-- Adds the Event layer to the existing Platform -> Organisation -> Event
-- inheritance chain. platform_defaults_settings and settings (org-scoped)
-- already exist; this is the missing third layer, following the exact same
-- key/value shape as settings so the same applySettingsToConfig() switch in
-- js/config.js can be reused unchanged for both.
--
-- Resolution order (js/config.js's loadStallCosts()): org rows applied
-- first, then event rows on top, so an event row with the same key wins.
-- The resolver does not care which keys exist here — any settings key can
-- gain an event-level override just by inserting a row; no resolver or
-- schema change required. Which keys the admin UI actually exposes for
-- per-event editing is a separate, later decision.

CREATE TABLE IF NOT EXISTS "public"."event_settings" (
    "event_id" text NOT NULL DEFAULT 'event_default',
    "key" text NOT NULL,
    "value" text,
    "updated_at" timestamp with time zone DEFAULT now(),
    "updated_by" text,
    PRIMARY KEY ("event_id", "key")
);

ALTER TABLE "public"."event_settings" OWNER TO "postgres";

COMMENT ON TABLE "public"."event_settings" IS
    'Runtime key/value configuration, scoped per event. Overrides the '
    'org-scoped settings table for the same key when a row exists here. '
    'Mirrors settings'' shape exactly (same key/value/updated_at/updated_by '
    'columns) so js/config.js''s applySettingsToConfig() resolves both '
    'without key-specific branching.';

COMMENT ON COLUMN "public"."event_settings"."event_id" IS
    'Event scope. Phase 1: always event_default. Not every settings key is '
    'expected to have an event row — only keys the admin UI exposes for '
    'per-event editing will ever be written here.';

COMMENT ON COLUMN "public"."event_settings"."updated_by" IS
    'Editor identity as a plain string (email), matching settings.updated_by '
    '— every existing settings writer passes userEmail, not an auth.users '
    'id, so this stays text for consistency rather than uuid.';

CREATE INDEX IF NOT EXISTS "idx_event_settings_event_id" ON "public"."event_settings" ("event_id");

ALTER TABLE "public"."event_settings" ENABLE ROW LEVEL SECURITY;

-- Mirrors "Allow admins full access to settings" exactly (same check, same
-- role table) — event_settings is edited by the same admin surface as
-- settings, not a new permission tier.
CREATE POLICY "Allow admins full access to event_settings" ON "public"."event_settings"
    TO "authenticated"
    USING ((EXISTS ( SELECT 1
       FROM "public"."user_roles"
      WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"public"."user_role")))))
    WITH CHECK ((EXISTS ( SELECT 1
       FROM "public"."user_roles"
      WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"public"."user_role")))));

-- Mirrors "Allow public anon to read non-sensitive settings" exactly (same
-- key allow-list) so a future public consumer (e.g. js/public-context.js)
-- can read an event override for any of these keys without a new RLS
-- decision. No event_id filter, same as the settings policy has no org_id
-- filter today — Phase 1, single event, consistent with existing scope.
CREATE POLICY "Allow public anon to read non-sensitive event_settings" ON "public"."event_settings"
    FOR SELECT TO "anon"
    USING (("key" = ANY (ARRAY[
        'stall_cost_food'::"text", 'stall_cost_general'::"text", 'stall_cost_dev'::"text",
        'turnstile_site_key'::"text", 'base_url'::"text", 'cancel_url'::"text", 'portal_url'::"text",
        'booking_prefix'::"text", 'bucket_name'::"text", 'hcc_council_email'::"text",
        'map_center_lat'::"text", 'map_center_lng'::"text", 'map_default_zoom'::"text",
        'food_bookings_open'::"text", 'general_bookings_open'::"text", 'sentry_browser_loader_url'::"text",
        'brand_primary_color'::"text", 'brand_accent_color'::"text", 'logo_url'::"text", 'logo_light_url'::"text",
        'org_support_email'::"text", 'email_footer_text'::"text"
    ])));

GRANT ALL ON TABLE "public"."event_settings" TO "service_role";
GRANT SELECT ON TABLE "public"."event_settings" TO "anon";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."event_settings" TO "authenticated";
