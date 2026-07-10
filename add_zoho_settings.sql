-- ===================================================================
-- INITIALIZE ZOHO MAIL API SETTINGS IN DATABASE
-- Run this script in the Supabase SQL Editor (https://supabase.com)
-- ===================================================================

INSERT INTO settings (key, value, updated_at, updated_by) VALUES
('zoho_client_id', '', now(), 'system'),
('zoho_client_secret', '', now(), 'system'),
('zoho_refresh_token', '', now(), 'system'),
('zoho_account_id', '', now(), 'system'),
('zoho_from_address', 'festival.stalls@ellastreet.co.uk', now(), 'system'),
('zoho_api_domain', 'https://mail.zoho.eu', now(), 'system'),
('zoho_accounts_domain', 'https://accounts.zoho.eu', now(), 'system'),
('booking_prefix', 'ESF26', now(), 'system')
ON CONFLICT (key) DO UPDATE 
SET value = CASE 
    -- Do not overwrite existing non-empty values
    WHEN settings.value IS NOT NULL AND settings.value <> '' THEN settings.value
    ELSE EXCLUDED.value
    END,
    updated_at = now(),
    updated_by = 'system';
