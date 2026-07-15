-- ===================================================================
-- CORRECT EXISTING STALL COSTS IN DATABASE TO MATCH CONFIG (50/25)
-- Run this script in the Supabase SQL Editor (https://supabase.com)
-- ===================================================================

-- 1. Update Food Stall costs from 100.00 to 50.00
UPDATE bookings 
SET stall_cost = 50.00 
WHERE (id LIKE 'ESF26-FOOD-%' OR id LIKE 'ESF26-FOOD-DEV-%') 
  AND (stall_cost = 100.00 OR stall_cost IS NULL);

-- 2. Update General/Non-Food Stall costs from 40.00 to 25.00
UPDATE bookings 
SET stall_cost = 25.00 
WHERE (id LIKE 'ESF26-NONFOOD-%' OR id LIKE 'ESF26-NONFOOD-DEV-%') 
  AND (stall_cost = 40.00 OR stall_cost IS NULL);
