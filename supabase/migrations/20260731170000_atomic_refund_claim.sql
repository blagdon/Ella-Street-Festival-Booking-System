-- Closes a check-then-act race in rpc_record_refund, the same class of bug
-- fixed for rpc_claim_stripe_session_slot (20260731130000): the "already
-- refunded?" guard was a plain SELECT with no row lock, so two genuinely
-- concurrent calls (e.g. an admin cancelling the refund modal mid-request
-- and reopening it against stale local data, then clicking Refund again
-- before the first request resolved) could both pass the check before
-- either committed.
--
-- For a FULL refund this was self-limiting - Stripe's own ledger refuses to
-- refund more than a charge's remaining balance, so the second
-- stripe.refunds.create() call would fail. But two concurrent PARTIAL
-- refunds that individually fit within the original charge (e.g. two £20
-- refunds against a £50 booking) could both succeed for real at Stripe, and
-- then the second call's UPDATE here - whose WHERE clause never re-checked
-- refund_amount - would silently overwrite the first's recorded
-- refund_amount/reference, leaving the database showing only one refund
-- while Stripe's own dashboard shows two.
--
-- Fixed the same way as the session-claim RPC: the UPDATE's WHERE clause is
-- now the actual atomic claim (repeats "paid = true AND refund_amount IS
-- NULL" as a real condition on the write, not just an earlier read), so
-- Postgres's row-level lock ensures only one of two concurrent UPDATEs can
-- ever match - the second blocks until the first commits, then re-evaluates
-- its WHERE clause against the now-committed refund_amount and finds no row.
-- The pre-checks (booking exists, has a payment, amount vs cost) stay as
-- plain SELECTs for clear, specific error messages in the common
-- (non-racing) case; only the actual claim needs to be atomic.

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
    v_paid boolean;
    v_already_refunded numeric;
BEGIN
    IF auth.uid() IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM user_roles WHERE id = auth.uid() AND role = 'admin'
        ) THEN
            RAISE EXCEPTION 'Not authorized';
        END IF;
        SELECT email INTO v_admin_email FROM user_roles WHERE id = auth.uid();
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

    SELECT b.stall_cost, p.paid, p.refund_amount
      INTO v_stall_cost, v_paid, v_already_refunded
      FROM bookings b
      LEFT JOIN payments p ON p.booking_id = b.id
     WHERE b.id = p_booking_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Booking % not found.', p_booking_id;
    END IF;

    IF v_paid IS NOT TRUE THEN
        RAISE EXCEPTION 'Booking % has no recorded payment to refund.', p_booking_id;
    END IF;

    IF v_already_refunded IS NOT NULL THEN
        RAISE EXCEPTION 'Booking % has already been refunded (%). Only one refund per booking is supported.', p_booking_id, v_already_refunded;
    END IF;

    IF v_stall_cost IS NOT NULL AND p_refund_amount > v_stall_cost THEN
        RAISE EXCEPTION 'Refund amount % exceeds the booking cost %.', p_refund_amount, v_stall_cost;
    END IF;

    -- The actual atomic claim - see the migration header above.
    UPDATE payments
    SET refund_amount = p_refund_amount,
        refunded_at = now(),
        refunded_by = v_actor,
        refund_reference = p_refund_reference,
        refund_notes = p_notes,
        updated_at = now()
    WHERE booking_id = p_booking_id AND paid = true AND refund_amount IS NULL;

    IF NOT FOUND THEN
        -- Lost the race: a concurrent call refunded this booking between the
        -- SELECT above and this UPDATE.
        RAISE EXCEPTION 'Booking % has already been refunded (refunded by a concurrent request). Only one refund per booking is supported.', p_booking_id;
    END IF;
END;
$$;

ALTER FUNCTION "public"."rpc_record_refund"("p_booking_id" "text", "p_refund_amount" numeric, "p_refund_reference" "text", "p_notes" "text", "p_refunded_by" "text") OWNER TO "postgres";
