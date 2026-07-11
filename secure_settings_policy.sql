-- ===================================================================
-- ENABLE ROW LEVEL SECURITY AND CONFIGURE POLICIES ON SETTINGS TABLE
-- Run this script in the Supabase SQL Editor (https://supabase.com)
-- ===================================================================

-- 1. Enable Row Level Security (RLS) on settings table
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- 2. Drop existing SELECT policies on settings table if they exist to prevent conflicts
DROP POLICY IF EXISTS "Allow public read access to settings" ON settings;
DROP POLICY IF EXISTS "Allow authenticated read access to settings" ON settings;
DROP POLICY IF EXISTS "Allow admins read access to settings" ON settings;
DROP POLICY IF EXISTS "Allow public anon to read non-sensitive settings" ON settings;
DROP POLICY IF EXISTS "Allow admins full access to settings" ON settings;

-- 3. Create SELECT policy for the public 'anon' role (strict key whitelist)
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
        'booking_prefix'
    )
);

-- 4. Create SELECT/INSERT/UPDATE/DELETE policy for authenticated admins
CREATE POLICY "Allow admins full access to settings"
ON settings FOR ALL TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM user_roles 
        WHERE user_roles.id = auth.uid() AND user_roles.role = 'admin'
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM user_roles 
        WHERE user_roles.id = auth.uid() AND user_roles.role = 'admin'
    )
);
