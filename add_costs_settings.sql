-- ===================================================================
-- INITIALIZE DEFAULT STALL COSTS IN DATABASE
-- Run this script in the Supabase SQL Editor (https://supabase.com)
-- ===================================================================

-- Create default settings for stall costs if they don't already exist
INSERT INTO settings (key, value, updated_at, updated_by) VALUES
('stall_cost_food', '50.00', now(), 'system'),
('stall_cost_general', '25.00', now(), 'system'),
('stall_cost_dev', '90.00', now(), 'system')
ON CONFLICT (key) DO UPDATE 
SET value = EXCLUDED.value,
    updated_at = now(),
    updated_by = 'system';
