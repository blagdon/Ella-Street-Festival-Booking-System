-- ===================================================================
-- FIX: calculate_performer_total_cost() silently drops non-30/60-minute
-- schedule entries instead of billing them
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- The CASE expression only matched duration_minutes = 30 or 60, with
-- no ELSE branch. Any other duration (45, 90, etc.) evaluated to NULL
-- for that row, which SUM() silently ignores rather than failing —
-- so an odd-length booking contributed $0 to the performer's total
-- cost instead of erroring or billing proportionally. This is live:
-- update_cost_on_schedule_change fires this on every schedules
-- insert/update/delete. Fixed by billing proportionally to
-- cost_per_30min for any duration, per the recommendation.
-- ===================================================================

CREATE OR REPLACE FUNCTION public.calculate_performer_total_cost(performer_uuid uuid)
 RETURNS numeric
 LANGUAGE plpgsql
AS $function$
DECLARE
  total DECIMAL(10,2);
BEGIN
  SELECT COALESCE(SUM(
    (s.duration_minutes / 30.0) * p.cost_per_30min
  ), 0)
  INTO total
  FROM schedules s
  JOIN performers p ON p.id = s.performer_id
  WHERE s.performer_id = performer_uuid;

  RETURN total;
END;
$function$;

-- ===================================================================
-- VERIFY:
--   SELECT calculate_performer_total_cost('<some performer uuid>');
--   -- Should return a proportional value for any duration, not just
--   -- ones evenly divisible by 30/60.
-- ===================================================================
