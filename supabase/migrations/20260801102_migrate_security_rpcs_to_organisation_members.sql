-- Migration: 20260801102_migrate_security_rpcs_to_organisation_members.sql
-- Phase 2 — Tenant Awareness & Normalisation: Step 2
--
-- Migrates check_user_role() and SECURITY DEFINER RPCs to read from
-- organisation_members (scoped by get_current_org_id()) with a fallback
-- to user_roles for total backwards compatibility.
--
-- Backwards compatibility guarantee:
--   Existing auth accounts and roles continue working seamlessly.

-- 1. check_user_role
CREATE OR REPLACE FUNCTION "public"."check_user_role"("required_role" "public"."user_role")
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
BEGIN
  -- Primary check: organisation_members for the current resolved tenant
  IF EXISTS (
    SELECT 1 FROM public.organisation_members 
    WHERE user_id = auth.uid() 
      AND org_id = get_current_org_id() 
      AND role = required_role::text
  ) THEN
    RETURN true;
  END IF;

  -- Fallback check: user_roles for backwards compatibility
  RETURN EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE id = auth.uid() AND role = required_role
  );
END;
$$;

ALTER FUNCTION "public"."check_user_role"("public"."user_role") OWNER TO postgres;

-- 2. rpc_record_bank_transfer_payment
CREATE OR REPLACE FUNCTION "public"."rpc_record_bank_transfer_payment"(
    "p_booking_id" "text",
    "p_payment_reference" "text",
    "p_notes" "text" DEFAULT NULL::"text"
) RETURNS "void"
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
DECLARE
    v_admin_email text;
BEGIN
    IF NOT check_user_role('admin') THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    IF p_payment_reference IS NULL OR trim(p_payment_reference) = '' THEN
        RAISE EXCEPTION 'Payment reference is required.';
    END IF;

    SELECT email INTO v_admin_email FROM user_roles WHERE id = auth.uid();
    IF v_admin_email IS NULL THEN
        SELECT u.email INTO v_admin_email FROM auth.users u WHERE u.id = auth.uid();
    END IF;

    UPDATE bookings
    SET status = 'Confirmed',
        date_confirmed = now()
    WHERE id = p_booking_id AND status = 'Payment Requested';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Booking % is not awaiting payment (status must be ''Payment Requested'').', p_booking_id;
    END IF;

    INSERT INTO payments (
        booking_id, paid, date_paid, bank_ref, editor,
        payment_method, payment_reference, verified_by, verified_at, notes, org_id
    )
    VALUES (
        p_booking_id, true, CURRENT_DATE, 'Bank transfer: ' || p_payment_reference, COALESCE(v_admin_email, 'Admin'),
        'bank_transfer', p_payment_reference, COALESCE(v_admin_email, 'Admin'), now(), p_notes, get_current_org_id()
    )
    ON CONFLICT (booking_id) DO UPDATE
    SET paid = true,
        date_paid = CURRENT_DATE,
        bank_ref = EXCLUDED.bank_ref,
        editor = EXCLUDED.editor,
        payment_method = 'bank_transfer',
        payment_reference = EXCLUDED.payment_reference,
        verified_by = EXCLUDED.verified_by,
        verified_at = EXCLUDED.verified_at,
        notes = EXCLUDED.notes,
        updated_at = now();
END;
$$;

ALTER FUNCTION "public"."rpc_record_bank_transfer_payment"("text", "text", "text") OWNER TO postgres;

-- 3. rpc_record_refund
CREATE OR REPLACE FUNCTION "public"."rpc_record_refund"(
    "p_booking_id" "text",
    "p_refund_amount" numeric,
    "p_refund_reference" "text",
    "p_notes" "text" DEFAULT NULL::"text",
    "p_refunded_by" "text" DEFAULT NULL::"text"
) RETURNS "void"
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
DECLARE
    v_admin_email text;
    v_actor text;
    v_stall_cost numeric;
    v_already_refunded numeric;
BEGIN
    IF auth.uid() IS NOT NULL THEN
        IF NOT check_user_role('admin') THEN
            RAISE EXCEPTION 'Not authorized';
        END IF;
        SELECT email INTO v_admin_email FROM user_roles WHERE id = auth.uid();
        IF v_admin_email IS NULL THEN
            SELECT u.email INTO v_admin_email FROM auth.users u WHERE u.id = auth.uid();
        END IF;
        v_actor := COALESCE(v_admin_email, 'Admin');
    ELSE
        v_actor := COALESCE(p_refunded_by, 'system');
    END IF;

    IF p_refund_reference IS NULL OR trim(p_refund_reference) = '' THEN
        RAISE EXCEPTION 'Refund reference is required.';
    END IF;

    IF p_refund_amount IS NULL OR p_refund_amount <= 0 THEN
        RAISE EXCEPTION 'Refund amount must be greater than zero.';
    END IF;

    SELECT b.stall_cost, p.refund_amount
      INTO v_stall_cost, v_already_refunded
      FROM bookings b
      LEFT JOIN payments p ON p.booking_id = b.id
     WHERE b.id = p_booking_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Booking % not found.', p_booking_id;
    END IF;

    IF v_already_refunded IS NOT NULL THEN
        RAISE EXCEPTION 'Booking % has already been refunded (%). Only one refund per booking is supported.', p_booking_id, v_already_refunded;
    END IF;

    IF v_stall_cost IS NOT NULL AND p_refund_amount > v_stall_cost THEN
        RAISE EXCEPTION 'Refund amount % exceeds the booking cost %.', p_refund_amount, v_stall_cost;
    END IF;

    UPDATE payments
    SET refund_amount = p_refund_amount,
        refunded_at = now(),
        refunded_by = v_actor,
        refund_reference = p_refund_reference,
        refund_notes = p_notes,
        updated_at = now()
    WHERE booking_id = p_booking_id AND paid = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Booking % has no recorded payment to refund.', p_booking_id;
    END IF;
END;
$$;

ALTER FUNCTION "public"."rpc_record_refund"("text", numeric, "text", "text", "text") OWNER TO postgres;

-- 4. rpc_set_booking_locations
CREATE OR REPLACE FUNCTION "public"."rpc_set_booking_locations"(
    "p_booking_id" "text",
    "p_location_ids" "text"[]
) RETURNS "void"
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
BEGIN
    IF NOT check_user_role('admin') AND NOT check_user_role('steward') THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    LOCK TABLE booking_locations IN SHARE ROW EXCLUSIVE MODE;

    DELETE FROM booking_locations WHERE booking_id = p_booking_id;

    INSERT INTO booking_locations (booking_id, location_id)
    SELECT p_booking_id, loc
    FROM unnest(p_location_ids) AS loc
    WHERE loc IS NOT NULL AND trim(loc) <> '';
END;
$$;

ALTER FUNCTION "public"."rpc_set_booking_locations"("text", "text"[]) OWNER TO postgres;

-- 5. rpc_get_next_misc_id
CREATE OR REPLACE FUNCTION "public"."rpc_get_next_misc_id"()
RETURNS "text"
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'public'
AS $_$
DECLARE
  v_prefix TEXT;
  v_max_num INT;
  v_new_id  TEXT;
BEGIN
  IF NOT check_user_role('admin') THEN
    RAISE EXCEPTION 'Not authorized: admin role required';
  END IF;

  LOCK TABLE bookings IN SHARE ROW EXCLUSIVE MODE;

  SELECT COALESCE(value, 'ESF26') || '-MISC-'
  INTO v_prefix
  FROM settings
  WHERE key = 'booking_prefix' AND org_id = get_current_org_id()
  LIMIT 1;

  IF v_prefix IS NULL THEN
    SELECT COALESCE(value, 'ESF26') || '-MISC-'
    INTO v_prefix
    FROM settings
    WHERE key = 'booking_prefix'
    LIMIT 1;
  END IF;

  IF v_prefix IS NULL THEN
    v_prefix := 'ESF26-MISC-';
  END IF;

  SELECT COALESCE(
    MAX(CAST(SPLIT_PART(id, v_prefix, 2) AS INT)),
    0
  )
  INTO v_max_num
  FROM bookings
  WHERE id LIKE v_prefix || '%'
    AND id ~ ('^' || v_prefix || '\d+$');

  v_new_id := v_prefix || LPAD((v_max_num + 1)::TEXT, 4, '0');

  RETURN v_new_id;
END;
$_$;

ALTER FUNCTION "public"."rpc_get_next_misc_id"() OWNER TO postgres;
