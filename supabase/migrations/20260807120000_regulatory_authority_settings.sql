-- Migration: 20260807120000_regulatory_authority_settings.sql
-- Version 1.1 Sprint 1, Issue 2 — Regulatory Authority.
--
-- Food_Stall_booking.html's mandatory hygiene-declaration checkbox and its
-- Public Liability Insurance declaration hardcoded "Hull City Council" and
-- "£5,000,000" directly in the HTML/JS (js/page-food-booking.js's
-- docs_checklist builder duplicated the same two strings). Neither is
-- meaningful for any organisation other than Ella Street — a different
-- tenant's traders would be declaring compliance with the wrong council's
-- regulations entirely.
--
-- Fix: two new settings/event_settings keys, following the exact same
-- org-default-then-event-override shape every other configurable value in
-- this table already uses (stall costs, festival_display_name, etc.) — no
-- new table or mechanism needed. Anon-readable (same allow-list pattern as
-- food_bookings_open/general_bookings_open, added 20260718140000) since the
-- public booking form needs to read them before an applicant is authenticated.
--
-- 'Existing organisations must continue working without manual
-- intervention' (sprint brief, Issue 2) is satisfied by seeding org_default
-- with its real current values below — no admin action required for the
-- existing single tenant to see byte-identical wording. Any OTHER
-- organisation simply has no row for these keys, so the application layer's
-- generic fallback wording applies automatically (see js/public-context.js's
-- initPublicBookingForm()) — this migration does not, and should not, seed
-- a default for any org other than org_default.

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
    'org_support_email'::"text", 'email_footer_text'::"text",
    'regulatory_authority_name'::"text", 'insurance_minimum_amount'::"text"
  ])));

ALTER POLICY "Allow public anon to read non-sensitive event_settings" ON "public"."event_settings"
    USING (("key" = ANY (ARRAY[
        'stall_cost_food'::"text", 'stall_cost_general'::"text", 'stall_cost_dev'::"text",
        'turnstile_site_key'::"text", 'base_url'::"text", 'cancel_url'::"text", 'portal_url'::"text",
        'booking_prefix'::"text", 'bucket_name'::"text", 'hcc_council_email'::"text",
        'map_center_lat'::"text", 'map_center_lng'::"text", 'map_default_zoom'::"text",
        'food_bookings_open'::"text", 'general_bookings_open'::"text", 'sentry_browser_loader_url'::"text",
        'brand_primary_color'::"text", 'brand_accent_color'::"text", 'logo_url'::"text", 'logo_light_url'::"text",
        'org_support_email'::"text", 'email_footer_text'::"text",
        'regulatory_authority_name'::"text", 'insurance_minimum_amount'::"text"
    ])));

INSERT INTO "public"."settings" ("org_id", "key", "value")
VALUES
    ('org_default', 'regulatory_authority_name', 'Hull City Council'),
    ('org_default', 'insurance_minimum_amount', '£5,000,000')
ON CONFLICT ("org_id", "key") DO NOTHING;
