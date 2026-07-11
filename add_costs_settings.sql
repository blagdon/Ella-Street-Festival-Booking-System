-- ===================================================================
-- INITIALIZE DEFAULT SETTINGS AND CONSTANTS IN DATABASE
-- Run this script in the Supabase SQL Editor (https://supabase.com)
-- ===================================================================

-- Create default settings for system configurations if they don't already exist
INSERT INTO settings (key, value, updated_at, updated_by) VALUES
('stall_cost_food', '50.00', now(), 'system'),
('stall_cost_general', '25.00', now(), 'system'),
('stall_cost_dev', '90.00', now(), 'system'),
('turnstile_site_key', '0x4AAAAAACZTfDIHzMhGqnER', now(), 'system'),
('bank_details', '', now(), 'system'),
('base_url', 'https://stallbookingstailwinds.vercel.app', now(), 'system'),
('cancel_url', 'https://stallbookingstailwinds.vercel.app/cancel_booking.html', now(), 'system'),
('portal_url', 'https://www.ellastreet.co.uk/fest26/portal', now(), 'system'),
('bucket_name', 'esf-documents', now(), 'system'),
('hcc_council_email', 'Foodand.Health&Safety@hullcc.gov.uk', now(), 'system'),
('email_rate_limit', '10', now(), 'system'),
('email_rate_window_ms', '60000', now(), 'system')
ON CONFLICT (key) DO UPDATE 
SET value = EXCLUDED.value,
    updated_at = now(),
    updated_by = 'system';
