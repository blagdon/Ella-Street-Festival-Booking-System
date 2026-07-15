-- ===================================================================
-- INITIALIZE FESTIVAL DISPLAY NAME SETTING IN DATABASE
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- Externalizes the "Ella Street Festival" brand name shown in the
-- admin header (js/nav.js), previously hardcoded. The "| {year} Admin"
-- suffix is unaffected — it's already derived automatically from the
-- booking_prefix setting. Admin-only page, so no anon RLS whitelist
-- change needed.
-- ===================================================================

INSERT INTO settings (key, value, updated_at, updated_by) VALUES
('festival_display_name', 'Ella Street Festival', now(), 'system')
ON CONFLICT (key) DO NOTHING;
