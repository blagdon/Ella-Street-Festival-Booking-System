-- ===================================================================
-- INITIALIZE ALLOWED STALL TYPES SETTING IN DATABASE
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- Externalizes CONFIG.UI.ALLOWED_TYPES, previously hardcoded in
-- js/config.js. Used to populate the "Stall Type" dropdown on the
-- booking details editor (js/details.js) and the Add Misc Entry page
-- (js/page-add-misc.js) — both authenticated admin-only pages, so this
-- key does not need to be added to the anon RLS whitelist.
-- Stored as a comma-separated list (none of the type names contain commas).
-- ===================================================================

INSERT INTO settings (key, value, updated_at, updated_by) VALUES
('allowed_stall_types', 'Dev,Food,Non-Food,Attraction,Barrier,Ramp,First Aid,Beach,Music,Green,Police,Fire Engine,Toilet,Spoken Word,Ice Cream Van', now(), 'system')
ON CONFLICT (key) DO NOTHING;
