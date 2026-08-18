-- Migration: 20260817140000_clear_test_booking_data.sql
-- Production test-booking-data cleanup (approved separately from, and
-- applied after, 20260817100000_retire_hcc_checks.sql).
--
-- Investigation performed immediately before authoring this migration
-- (read-only, against production): every one of the 197 bookings currently
-- in production shares the exact same email address
-- (shaun.blagdon@gmail.com — the account owner's own address), 100% belong
-- to org_default/event_default, and business names include clearly
-- non-customer test entries ("correction test", "Shaun trading",
-- "Blaggers Burgers dgdfgdrg"). Zero distinct customer emails exist.
-- Confirmed and explicitly approved as disposable test data, not genuine
-- customer bookings.
--
-- Dependency inventory performed first (schema-derived, not assumed):
-- exactly three tables have a real FK to bookings, all ON DELETE CASCADE —
-- booking_locations, hcc_checks, payments. hcc_checks is already gone by
-- the time this migration runs (dropped by 20260817100000, applied first).
-- audit_logs has no FK to bookings, only a free-text `target_id` column
-- also used for org/event/settings/user-management/system actions
-- (admin_login, update_zoho_settings, create_event, toggle_booking_form,
-- etc.) — of 1933 rows, only 1688 have a target_id matching a currently-
-- existing booking id; those 1688 are deleted below, the other 245 are
-- untouched. email_queue (838 rows, 239 free-text-mention a current
-- booking id), sms_queue (74 rows, 25 mention one), and storage.objects
-- (136 rows, 111 mention one in their path) all lack any booking_id
-- column or FK entirely — no structurally safe ownership relationship
-- exists, so none of the three are touched by this migration, matching
-- the same reasoning already applied to email_queue/sms_queue in
-- 20260815210000_phase3_dev_location_retirement.sql.
--
-- No triggers exist on bookings; no function performs a DELETE FROM
-- bookings. organisations, events, locations, organisation_members,
-- user_roles, settings, and event_settings have no dependency on bookings
-- at all and are entirely untouched by this migration.
--
-- Also included (explicitly approved as part of this cleanup, since the
-- 'HCC Checks' status is now fully retired and no booking will ever hold
-- it again): cancel_booking_secure's allowed-source-status list no longer
-- mentions 'HCC Checks'. No other change to that function.

-- ---------------------------------------------------------------------
-- 1. audit_logs rows demonstrably associated with a booking about to be
--    deleted (target_id matches a current booking id). Every other
--    audit_logs row (org/event/settings/user-management/system actions,
--    and any pre-existing reference to an already-long-gone booking id)
--    is left untouched.
-- ---------------------------------------------------------------------
DELETE FROM public.audit_logs
WHERE target_id IN (SELECT id FROM public.bookings);

-- ---------------------------------------------------------------------
-- 2. payments and booking_locations rows for the bookings being deleted.
--    Explicit, not left to CASCADE, matching this repo's established
--    migration style (20260815210000).
-- ---------------------------------------------------------------------
DELETE FROM public.payments
WHERE booking_id IN (SELECT id FROM public.bookings);

DELETE FROM public.booking_locations
WHERE booking_id IN (SELECT id FROM public.bookings);

-- ---------------------------------------------------------------------
-- 3. The bookings themselves.
-- ---------------------------------------------------------------------
DELETE FROM public.bookings;

-- ---------------------------------------------------------------------
-- 4. Drop the now-permanently-unreachable 'HCC Checks' branch from
--    cancel_booking_secure's allowed-source-status check. No other
--    change to this function.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_booking_secure(p_token uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_booking_id TEXT;
  v_status TEXT;
BEGIN
  SELECT id, status INTO v_booking_id, v_status
  FROM bookings
  WHERE cancel_token = p_token;

  IF v_booking_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired cancel token.');
  END IF;

  IF v_status NOT IN ('Pending', 'Confirmed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Booking cannot be cancelled in its current state.');
  END IF;

  UPDATE bookings
  SET status = 'Cancelled',
      rejection_reason = p_reason,
      cancel_token = NULL
  WHERE id = v_booking_id;

  RETURN jsonb_build_object('success', true, 'booking_id', v_booking_id);
END;
$function$
;
