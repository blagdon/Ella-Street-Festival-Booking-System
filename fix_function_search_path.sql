-- ===================================================================
-- FIX: pin SET search_path on SECURITY DEFINER functions
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- SECURITY DEFINER functions run with the privileges of their owner,
-- but without an explicit search_path, unqualified references resolve
-- using the CALLER's search_path at call time — standard Postgres/
-- Supabase hardening guidance is to always pin it. check_user_role and
-- get_is_admin already do this correctly; cancel_booking_secure and
-- get_next_booking_id did not. Bodies are unchanged — this only adds
-- the SET clause. (is_admin() is handled separately, in
-- drop_unused_admin_functions.sql, since it's unused dead code rather
-- than something worth patching.)
-- ===================================================================

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

  IF v_status NOT IN ('Pending', 'Confirmed', 'On Hold', 'HCC Checks') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Booking cannot be cancelled in its current state.');
  END IF;

  UPDATE bookings
  SET status = 'Cancelled',
      rejection_reason = p_reason,
      cancel_token = NULL
  WHERE id = v_booking_id;

  RETURN jsonb_build_object('success', true, 'booking_id', v_booking_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_next_booking_id(p_prefix text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_max_num INT;
  v_new_id  TEXT;
BEGIN
  -- Lock the table to prevent concurrent calls getting the same number
  LOCK TABLE bookings IN SHARE ROW EXCLUSIVE MODE;

  SELECT COALESCE(
    MAX(CAST(SPLIT_PART(id, p_prefix, 2) AS INT)),
    0
  )
  INTO v_max_num
  FROM bookings
  WHERE id LIKE p_prefix || '%'
    AND id ~ ('^' || p_prefix || '\d+$');

  v_new_id := p_prefix || LPAD((v_max_num + 1)::TEXT, 4, '0');

  RETURN v_new_id;
END;
$function$;

-- ===================================================================
-- VERIFY:
--   SELECT proname, proconfig FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN ('cancel_booking_secure', 'get_next_booking_id');
--   -- Both should now show {"search_path=public"}.
-- ===================================================================
