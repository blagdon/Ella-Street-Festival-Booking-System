-- Migration: 20260807060000_consolidate_rpc_org_role_check.sql
-- Closes a Low-severity finding from the Architecture Compliance Audit's
-- technical-debt table: the six RPCs fixed in
-- 20260806030000_decision4_rpc_authorisation_completion.sql each
-- independently inline the same `is_platform_admin() OR
-- has_org_role(<org>, <roles>)` boolean rather than sharing one check -
-- exactly the kind of drift that let the original Decision 4 gap happen in
-- the first place (a pattern copied by hand, table by table/RPC by RPC,
-- with nothing enforcing that a future addition copies it correctly).
--
-- Extracts that shared boolean into one SECURITY DEFINER helper,
-- is_authorised_for_org(), mirroring has_org_role()/is_platform_admin()'s
-- own LANGUAGE sql STABLE SECURITY DEFINER style. Not granted to
-- anon/authenticated: it is only ever called from inside another SECURITY
-- DEFINER function's body (these six RPCs), which already executes as the
-- function owner - a nested call in that context is checked against the
-- owner's privileges, not the original caller's, so no direct-RPC grant is
-- needed and none is given, keeping it un-callable from the client library.
--
-- Pure duplication fix, not a behaviour change: every RPC's own RAISE
-- EXCEPTION message is untouched, and rpc_initialise_tenant_defaults keeps
-- its extra service_role OR-clauses inline (a genuinely different,
-- three-way trust boundary the other five don't have - see
-- 20260806030000's own header comment). Covered by the existing
-- tests/rpc-authorisation.test.mjs suite; no new tests needed since nothing
-- about what's allowed or rejected changes.

CREATE OR REPLACE FUNCTION "public"."is_authorised_for_org"("p_org_id" text, "p_roles" text[])
RETURNS boolean
LANGUAGE "sql" STABLE SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
    SELECT "public"."is_platform_admin"() OR "public"."has_org_role"(p_org_id, p_roles);
$$;

-- ---------------------------------------------------------------------
-- rpc_add_organisation_member
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."rpc_add_organisation_member"("p_email" text, "p_role" text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid;
    v_org_id text := get_current_org_id();
    v_role_enum user_role;
BEGIN
    IF NOT is_authorised_for_org(v_org_id, ARRAY['admin']) THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required';
    END IF;

    IF p_email IS NULL OR trim(p_email) = '' THEN
        RAISE EXCEPTION 'User email address is required';
    END IF;

    IF p_role NOT IN ('admin', 'steward') THEN
        RAISE EXCEPTION 'Invalid role: %', p_role;
    END IF;

    v_role_enum := p_role::user_role;

    SELECT id INTO v_user_id
    FROM auth.users
    WHERE lower(email) = lower(trim(p_email))
    LIMIT 1;

    IF v_user_id IS NULL THEN
        SELECT id INTO v_user_id
        FROM public.user_roles
        WHERE lower(email) = lower(trim(p_email))
        LIMIT 1;
    END IF;

    IF v_user_id IS NULL THEN
        v_user_id := gen_random_uuid();
    END IF;

    INSERT INTO public.user_roles (id, email, role)
    VALUES (v_user_id, lower(trim(p_email)), v_role_enum)
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, email = EXCLUDED.email;

    INSERT INTO public.organisation_members (org_id, user_id, role)
    VALUES (v_org_id, v_user_id, p_role)
    ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role;

    RETURN jsonb_build_object(
        'status', 'success',
        'user_id', v_user_id,
        'email', lower(trim(p_email)),
        'role', p_role
    );
END;
$$;

-- ---------------------------------------------------------------------
-- rpc_record_bank_transfer_payment
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."rpc_record_bank_transfer_payment"("p_booking_id" text, "p_payment_reference" text, "p_notes" text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_admin_email text;
    v_booking_org_id text;
BEGIN
    SELECT org_id INTO v_booking_org_id FROM bookings WHERE id = p_booking_id;

    IF NOT is_authorised_for_org(v_booking_org_id, ARRAY['admin']) THEN
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
        'bank_transfer', p_payment_reference, COALESCE(v_admin_email, 'Admin'), now(), p_notes, v_booking_org_id
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

-- ---------------------------------------------------------------------
-- rpc_record_refund — authenticated branch only; the service/system
-- branch (auth.uid() IS NULL) is untouched.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."rpc_record_refund"("p_booking_id" text, "p_refund_amount" numeric, "p_refund_reference" text, "p_notes" text DEFAULT NULL::text, "p_refunded_by" text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_admin_email text;
    v_actor text;
    v_booking_org_id text;
    v_stall_cost numeric;
    v_already_refunded numeric;
BEGIN
    IF auth.uid() IS NOT NULL THEN
        SELECT org_id INTO v_booking_org_id FROM bookings WHERE id = p_booking_id;

        IF NOT is_authorised_for_org(v_booking_org_id, ARRAY['admin']) THEN
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

-- ---------------------------------------------------------------------
-- rpc_set_booking_locations
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."rpc_set_booking_locations"("p_booking_id" text, "p_location_ids" text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_booking_org_id text;
BEGIN
    SELECT org_id INTO v_booking_org_id FROM bookings WHERE id = p_booking_id;

    IF NOT is_authorised_for_org(v_booking_org_id, ARRAY['admin', 'steward']) THEN
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

-- ---------------------------------------------------------------------
-- rpc_get_next_misc_id
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."rpc_get_next_misc_id"()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prefix TEXT;
  v_max_num INT;
  v_new_id  TEXT;
BEGIN
  IF NOT is_authorised_for_org(get_current_org_id(), ARRAY['admin']) THEN
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
$$;

-- ---------------------------------------------------------------------
-- rpc_initialise_tenant_defaults — the admin branch now goes through
-- is_authorised_for_org(); the service_role branch (real provisioning
-- caller) keeps its own explicit OR-clauses, since that three-way trust
-- boundary (platform admin / org admin / service role) isn't shared by
-- any of the other five RPCs.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."rpc_initialise_tenant_defaults"("p_org_id" text, "p_display_name" text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_setting_count integer := 0;
    v_email_count integer := 0;
    v_sms_count integer := 0;
BEGIN
    IF NOT (is_authorised_for_org(p_org_id, ARRAY['admin']) OR current_setting('role', true) = 'service_role' OR auth.role() = 'service_role') THEN
        RAISE EXCEPTION 'Unauthorized: Admin or Service Role required';
    END IF;

    IF p_org_id IS NULL OR trim(p_org_id) = '' THEN
        RAISE EXCEPTION 'Organisation ID is required';
    END IF;

    -- Clone settings from platform_defaults_settings (DO NOTHING on conflict)
    INSERT INTO public.settings (org_id, key, value, updated_at, updated_by)
    SELECT p_org_id, key, value, now(), 'system_provisioner'
    FROM public.platform_defaults_settings
    ON CONFLICT (org_id, key) DO NOTHING;
    GET DIAGNOSTICS v_setting_count = ROW_COUNT;

    -- Clone email templates (DO NOTHING on conflict)
    INSERT INTO public.email_templates (org_id, id, subject, body_html, description, updated_at)
    SELECT p_org_id, id, subject, body_html, description, now()
    FROM public.platform_defaults_email_templates
    ON CONFLICT (org_id, id) DO NOTHING;
    GET DIAGNOSTICS v_email_count = ROW_COUNT;

    -- Clone SMS templates (DO NOTHING on conflict)
    INSERT INTO public.sms_templates (org_id, id, body, description, updated_at)
    SELECT p_org_id, id, body, description, now()
    FROM public.platform_defaults_sms_templates
    ON CONFLICT (org_id, id) DO NOTHING;
    GET DIAGNOSTICS v_sms_count = ROW_COUNT;

    -- Override the just-cloned generic placeholder with the org's actual
    -- display name, when the caller supplied one.
    IF p_display_name IS NOT NULL AND trim(p_display_name) <> '' THEN
        INSERT INTO public.settings (org_id, key, value, updated_at, updated_by)
        VALUES (p_org_id, 'festival_display_name', trim(p_display_name), now(), 'system_provisioner')
        ON CONFLICT (org_id, key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now(), updated_by = 'system_provisioner';
    END IF;

    RETURN jsonb_build_object(
        'status', 'success',
        'org_id', p_org_id,
        'settings_initialised', v_setting_count,
        'email_templates_initialised', v_email_count,
        'sms_templates_initialised', v_sms_count
    );
END;
$$;
