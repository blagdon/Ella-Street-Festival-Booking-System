-- ===================================================================
-- FIX: remove orphaned trigger functions with hardcoded stale URLs
-- and a hardcoded regulatory email address
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- handle_new_booking_email(), queue_booking_receipt_email(), and
-- trigger_auto_response() are three superseded attempts at queuing
-- the "application received" email, each hardcoding a different,
-- now-stale Vercel/domain URL for the cancel link. The current,
-- working implementation lives in the submit-booking Edge Function
-- (sendReceivedEmail()) instead.
--
-- trigger_hcc_workflow() is a superseded attempt at notifying Hull
-- City Council when a booking moves to 'HCC Checks', hardcoding the
-- real council email address (foodsafety@hullcc.gov.uk). The current,
-- working implementation is the manual "send email" action on the HCC
-- dashboard (js/page-hcc-dashboard.js), which is environment-aware
-- (redirects to the admin's own inbox in DEV instead of the real
-- council) and audit-logged — neither of which this function does.
--
-- None of the four are currently attached to any trigger (confirmed
-- via a full, unfiltered pg_trigger dump) and none are referenced by
-- any other function or by any app code (grepped). They are dead code
-- that would silently start firing — bypassing the DEV-safety redirect
-- and audit log for the HCC case — if anyone ever attached one of them
-- to bookings via CREATE TRIGGER. Deleting them removes that landmine.
-- ===================================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'handle_new_booking_email',
        'queue_booking_receipt_email',
        'trigger_auto_response',
        'trigger_hcc_workflow'
      )
  LOOP
    EXECUTE format('DROP FUNCTION %s', r.sig);
  END LOOP;
END $$;

-- ===================================================================
-- VERIFY:
--   SELECT proname FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN (
--       'handle_new_booking_email', 'queue_booking_receipt_email',
--       'trigger_auto_response', 'trigger_hcc_workflow'
--     );
--   -- Should return 0 rows.
-- ===================================================================
