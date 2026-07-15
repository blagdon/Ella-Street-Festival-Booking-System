-- ===================================================================
-- FIX: retire handle_cancel_email() — cancellation confirmation emails
-- are now sent directly by the cancel-booking Edge Function
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- handle_cancel_email() only ever inserted an email_queue row with
-- status='Pending'. Nothing in this app processes 'Pending' rows —
-- every other email path sends synchronously and logs the outcome
-- afterward — so cancellation confirmation emails were silently never
-- delivered. cancel-booking/index.ts now sends the email directly
-- (same send-then-log pattern as submit-booking), making this trigger
-- both redundant and non-functional. Deploy the updated Edge Function
-- before running this.
-- ===================================================================

DROP TRIGGER IF EXISTS on_booking_cancelled ON public.bookings;
DROP FUNCTION IF EXISTS public.handle_cancel_email();

-- ===================================================================
-- VERIFY:
--   SELECT tgname FROM pg_trigger WHERE tgname = 'on_booking_cancelled';
--   SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'handle_cancel_email';
--   -- Both should return 0 rows.
-- ===================================================================
