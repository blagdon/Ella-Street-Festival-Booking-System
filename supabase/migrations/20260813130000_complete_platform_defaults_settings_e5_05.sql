-- Migration: 20260813130000_complete_platform_defaults_settings_e5_05.sql
-- E5-05 (Epic 5 findings reconciliation) — platform_defaults_settings, the
-- seed source rpc_initialise_tenant_defaults() clones into every newly
-- provisioned organisation's own settings table, was missing several keys
-- the application actually reads a hardcoded fallback for. A new org's
-- admin who never manually configures these silently inherits Ella Street
-- Festival's own values: its bucket, its cancel-link/portal domain, and —
-- worst of the five — Hull City Council's real regulatory email address for
-- food-safety compliance correspondence that was never meant for them.
--
-- This migration implements the six keys confirmed safe under the CURRENT
-- architecture after a dedicated investigation (not the original 12-key
-- finding recreated mechanically — three of those keys are deliberately
-- excluded here because later architecture decisions superseded them):
--
--   - sentry_dsn / sentry_browser_loader_url: E5-19 made Sentry configuration
--     explicitly platform-level (org_default only) — a per-org copy in a new
--     tenant's own settings row would never be read by any code path.
--   - logo_url / logo_light_url: already correctly optional-by-design
--     (js/nav.js falls back to a plain-text header when empty) — seeding
--     these adds a row that does nothing a missing row doesn't already do.
--   - turnstile_site_key / map_center_lat / map_center_lng: each raises its
--     own architectural question (Turnstile verification currently uses one
--     platform-wide secret regardless of which org's site key was used;
--     map coordinates conceptually belong at the event/festival-edition
--     level, which the settings/event_settings override pattern already
--     supports but has never been populated for these keys) — tracked
--     separately, not implemented here.
--
-- Two of the six values are deliberately seeded EMPTY, not with Ella
-- Street's own real values, because there is no safe universal default:
--   - hcc_council_email: a real council email is genuinely org-specific
--     (which regulatory authority a food-safety notice goes to) — silently
--     defaulting a new commercial tenant to Hull City Council's real inbox
--     would misdirect real regulatory correspondence, not just look wrong.
--   - portal_url: Ella Street's own value is that organisation's own public
--     marketing page (https://www.ellastreet.co.uk/fest26), not a generic
--     platform URL — there is no equivalent page for a new tenant.
--
-- base_url, cancel_url, and bucket_name are different in kind: under the
-- CURRENT single-deployment architecture (one Vercel app, one domain, one
-- shared Supabase Storage bucket with booking-ID-scoped paths), Ella
-- Street's own values genuinely ARE the platform's real, only-working
-- values for every organisation today — seeding them is not "wrongly
-- forcing Ella Street's identity onto a new tenant," it is accurately
-- describing shared infrastructure every tenant already depends on.
--
-- Existing organisations (including org_default) are NOT affected by this
-- migration: rpc_initialise_tenant_defaults() clones platform_defaults_settings
-- via `ON CONFLICT (org_id, key) DO NOTHING`, and only runs once, at
-- provisioning time for a brand-new org_id. No backfill is performed or
-- proposed here — a deliberate scope decision, not an oversight.

INSERT INTO "public"."platform_defaults_settings" (key, value, category) VALUES
    ('base_url', 'https://app.ellastreet.co.uk', 'platform'),
    ('cancel_url', 'https://app.ellastreet.co.uk/cancel_booking.html', 'platform'),
    ('bucket_name', 'esf-documents', 'platform'),
    ('map_default_zoom', '18', 'booking'),
    ('portal_url', '', 'platform'),
    ('hcc_council_email', '', 'booking')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, category = EXCLUDED.category;
