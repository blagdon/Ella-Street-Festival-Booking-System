-- Removes 'On Hold' as an application-level booking status. Confirmed live
-- via the Kanban board before writing this migration: zero bookings were
-- sitting in 'On Hold' across the FOOD, GENERAL, and DEV instances, so
-- there are no existing rows to reassign/migrate.
--
-- bookings.status has no CHECK constraint (a plain text column), so the
-- only enforcement of "what's a valid status" lives in js/config.js's
-- STATUS_LIST / js/utils.js's validateStatus() — no schema change needed
-- there. The one place the database itself hard-codes 'On Hold' is
-- cancel_booking_secure()'s allowed-statuses check (a self-service
-- cancellation must only work from a state where cancelling still makes
-- sense) — that's a real behavioral change, so it needs a forward-fix here
-- rather than just a frontend edit, per this repo's "never edit an
-- already-applied migration" rule.
CREATE OR REPLACE FUNCTION "public"."cancel_booking_secure"("p_token" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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

  IF v_status NOT IN ('Pending', 'Confirmed', 'HCC Checks') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Booking cannot be cancelled in its current state.');
  END IF;

  UPDATE bookings
  SET status = 'Cancelled',
      rejection_reason = p_reason,
      cancel_token = NULL
  WHERE id = v_booking_id;

  RETURN jsonb_build_object('success', true, 'booking_id', v_booking_id);
END;
$$;
