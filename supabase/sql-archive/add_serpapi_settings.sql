-- ===================================================================
-- INITIALIZE SERPAPI SETTINGS IN DATABASE
-- Run this script in the Supabase SQL Editor (https://supabase.com)
-- Used for fetching Google Maps reviews via SerpApi
-- ===================================================================

INSERT INTO settings (key, value, updated_at, updated_by) VALUES
('serpapi_api_key', '', now(), 'system')
ON CONFLICT (key) DO NOTHING;
