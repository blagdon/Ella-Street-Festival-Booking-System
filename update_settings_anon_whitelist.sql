-- ===================================================================
-- UPDATE ANON READ WHITELIST ON SETTINGS TABLE
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- Supersedes the anon SELECT policy created in secure_settings_policy.sql.
-- Adds two keys that are already read client-side by unauthenticated
-- visitors (via applyPublicSettings in supabase-public.js) but were
-- missing from the whitelist, so anon requests were silently falling
-- back to hardcoded defaults instead of live DB values:
--   - bucket_name
--   - hcc_council_email
-- Also adds the three new map-center keys from add_map_center_settings.sql,
-- needed by the public visitor map.
-- ===================================================================

DROP POLICY IF EXISTS "Allow public anon to read non-sensitive settings" ON settings;

CREATE POLICY "Allow public anon to read non-sensitive settings"
ON settings FOR SELECT TO anon
USING (
    key IN (
        'stall_cost_food',
        'stall_cost_general',
        'stall_cost_dev',
        'turnstile_site_key',
        'base_url',
        'cancel_url',
        'portal_url',
        'booking_prefix',
        'bucket_name',
        'hcc_council_email',
        'map_center_lat',
        'map_center_lng',
        'map_default_zoom'
    )
);
