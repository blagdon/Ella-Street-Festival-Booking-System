-- ===================================================================
-- REMOVE UNUSED GOOGLE MAPS API KEY SETTING
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- add_google_maps_settings.sql inserted a 'google_maps_api_key' row that
-- nothing in the codebase ever reads (Google Maps search is done via
-- SerpApi's 'serpapi_api_key' instead). Removing the orphaned row rather
-- than leaving an unused, potentially-sensitive-looking key sitting in
-- the settings table.
-- ===================================================================

DELETE FROM settings WHERE key = 'google_maps_api_key';
