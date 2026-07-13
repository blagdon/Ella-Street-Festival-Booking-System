-- ===================================================================
-- INITIALIZE MAP CENTER SETTINGS IN DATABASE
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- Externalizes the festival site's GPS center + default zoom, previously
-- hardcoded in js/map.js (visitor map) and duplicated as a separate
-- literal in supabase/functions/get-reviews/index.ts (Google Maps search
-- location bias + distance backstop). Both now read from these same
-- three keys, so the two locations can't drift out of sync.
-- ===================================================================

INSERT INTO settings (key, value, updated_at, updated_by) VALUES
('map_center_lat', '53.760672928799394', now(), 'system'),
('map_center_lng', '-0.362403011338408', now(), 'system'),
('map_default_zoom', '18', now(), 'system')
ON CONFLICT (key) DO NOTHING;
