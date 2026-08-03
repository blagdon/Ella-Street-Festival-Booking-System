-- Migration: 20260803120000_consolidate_branding_defaults.sql
--
-- Epic 3 final hardening (EP3-02): platform_defaults_settings seeded
-- 'primary_color'/'accent_color'/'support_email' (20260802100_create_platform_defaults.sql),
-- but the Branding & Identity form (js/page-admin.js) reads/writes a
-- differently-named key for each of those concepts:
-- 'brand_primary_color'/'brand_accent_color'/'org_support_email'. The seeded
-- keys were therefore dead — cloned into every newly provisioned
-- organisation's settings table by rpc_initialise_tenant_defaults, but never
-- read back by anything, so the Branding form always fell through to its own
-- hard-coded fallback values (which happened to be this app's own configured
-- colours/email/logo, not neutral placeholders — the actual bug the
-- operational readiness review reported as EP3-02).
--
-- This migration retires the unused key names and adds the keys the form
-- actually reads, with neutral (non-Ella-Street) values, plus logo/footer
-- keys that weren't seeded at all before. logo_url/logo_light_url are
-- deliberately left unseeded: an empty logo is the correct "no logo
-- configured yet" state (js/nav.js already renders nothing when
-- CONFIG.BRANDING.LOGO_URL is empty), not a placeholder image URL.
--
-- Existing organisations already provisioned before this migration keep
-- whatever they already have — this only changes what gets cloned into
-- ORGANISATIONS PROVISIONED FROM NOW ON. Confirmed org_default carries none
-- of the old or new key names today, so nothing existing is affected either
-- way.

DELETE FROM "public"."platform_defaults_settings"
WHERE "key" IN ('primary_color', 'accent_color', 'support_email');

INSERT INTO "public"."platform_defaults_settings" (key, value, category) VALUES
    ('brand_primary_color', '#2563EB', 'branding'),
    ('brand_accent_color', '#64748B', 'branding'),
    ('org_support_email', 'support@example.com', 'branding'),
    ('email_footer_text', '', 'branding')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, category = EXCLUDED.category;
