-- ===================================================================
-- INITIALIZE GOOGLE MAPS API KEY SETTING IN DATABASE
-- Run this script in the Supabase SQL Editor (https://supabase.com)
-- ===================================================================

INSERT INTO settings (key, value, updated_at, updated_by) VALUES
('google_maps_api_key', '', now(), 'system')
ON CONFLICT (key) DO NOTHING;
