-- Migration: 20260804090000_public_identity_resolution.sql
-- Epic 4, Phase 4A — Public Identity & Event Resolution.
--
-- Anon currently has zero read access to organisations/events (every
-- existing policy is check_user_role('admin') or get_current_org_id()-gated,
-- both of which require auth.uid()). This adds the minimum anon-readable
-- surface a public /{orgSlug}/{eventSlug} resolver needs — organisations.id
-- and events.id are NOT anon-readable, only these two new views are, and
-- only non-sensitive columns are exposed (organisations.contact_email is
-- deliberately excluded, mirroring how public_bookings_info already
-- excludes bookings' own PII columns for the same reason).
--
-- Draft events are deliberately excluded from public_events_info: a public
-- visitor shouldn't be able to resolve a still-being-configured event by
-- guessing its slug, even before Phase 4E's full publishing-validation
-- workflow exists.

CREATE OR REPLACE VIEW "public"."public_organisations_info" AS
SELECT "id", "slug", "name", "website"
FROM "public"."organisations";

ALTER VIEW "public"."public_organisations_info" OWNER TO "postgres";

GRANT SELECT ON TABLE "public"."public_organisations_info" TO "anon";
GRANT SELECT ON TABLE "public"."public_organisations_info" TO "authenticated";
GRANT ALL    ON TABLE "public"."public_organisations_info" TO "service_role";

CREATE OR REPLACE VIEW "public"."public_events_info" AS
SELECT "id", "org_id", "slug", "name", "status", "booking_prefix", "is_active"
FROM "public"."events"
WHERE "status" <> 'draft';

ALTER VIEW "public"."public_events_info" OWNER TO "postgres";

GRANT SELECT ON TABLE "public"."public_events_info" TO "anon";
GRANT SELECT ON TABLE "public"."public_events_info" TO "authenticated";
GRANT ALL    ON TABLE "public"."public_events_info" TO "service_role";

-- Branding is read via the existing anon-readable settings allow-list
-- (same mechanism turnstile_site_key/sentry_browser_loader_url already use),
-- not a new table/view — one mechanism for "settings anon may read", not two.
-- Not org-scoped by the policy itself (same as every other key already on
-- this list) — the calling query is expected to filter by the org_id
-- resolved from public_organisations_info, exactly as the admin-side reader
-- (js/config.js's applySettingsToConfig) already does for its own org.
ALTER POLICY "Allow public anon to read non-sensitive settings" ON "public"."settings"
  USING (("key" = ANY (ARRAY[
    'stall_cost_food'::"text", 'stall_cost_general'::"text", 'stall_cost_dev'::"text",
    'turnstile_site_key'::"text", 'base_url'::"text", 'cancel_url'::"text", 'portal_url'::"text",
    'booking_prefix'::"text", 'bucket_name'::"text", 'hcc_council_email'::"text",
    'map_center_lat'::"text", 'map_center_lng'::"text", 'map_default_zoom'::"text",
    'food_bookings_open'::"text", 'general_bookings_open'::"text",
    'sentry_browser_loader_url'::"text",
    'brand_primary_color'::"text", 'brand_accent_color'::"text",
    'logo_url'::"text", 'logo_light_url'::"text",
    'org_support_email'::"text", 'email_footer_text'::"text"
  ])));
