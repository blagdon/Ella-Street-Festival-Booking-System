-- Refund support: schema + the RPC that records a refund atomically.
--
-- Deliberately built alongside the actual feature rather than speculatively —
-- HANDOVER's "Known gaps" entry has said since 2026-07-15 to add these columns
-- with the refund code, not before, precisely so the shape follows real
-- requirements. This is that moment.
--
-- WHY THESE COLUMNS AND NOT A SEPARATE `refunds` TABLE — the one real design
-- decision here. `payments` is keyed one-row-per-booking (booking_id is the
-- PK), so a refund is naturally a state change on that row. Storing an
-- explicit `refund_amount` (rather than just a boolean) supports a PARTIAL
-- refund — e.g. a late cancellation refunded at 50% — which is a genuinely
-- plausible festival scenario and costs nothing extra to allow, since Stripe's
-- refund API takes an optional amount anyway.
--
-- What this shape does NOT support is MULTIPLE separate refunds against one
-- booking (two partial refunds on different dates). That would need a real
-- `refunds` child table, and building one now would be speculative complexity
-- for a 9-payment festival — the same trap the original "don't add these
-- columns yet" note was avoiding. If multiple-refunds ever becomes a real
-- requirement, migrate to a child table then; the columns below carry enough
-- information (amount, timestamp, actor, external reference) to backfill one
-- row per existing refund without data loss.
--
-- `refunded_by` doubles as the provenance marker, mirroring how `editor`
-- already distinguishes automated Stripe payments from admin-entered ones:
-- an admin email means a human recorded it, 'Stripe (automatic)' means the
-- charge.refunded webhook did.

ALTER TABLE "public"."payments"
  ADD COLUMN IF NOT EXISTS "refund_amount" numeric(10,2),
  ADD COLUMN IF NOT EXISTS "refunded_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "refunded_by" "text",
  ADD COLUMN IF NOT EXISTS "refund_reference" "text",
  ADD COLUMN IF NOT EXISTS "refund_notes" "text";

COMMENT ON COLUMN "public"."payments"."refund_amount" IS
  'Amount refunded, in the same units as bookings.stall_cost. NULL = not refunded. May be less than stall_cost (partial refund). Only one refund per booking is representable - see the migration that added this.';
COMMENT ON COLUMN "public"."payments"."refunded_by" IS
  'Admin email for a manually recorded refund, or ''Stripe (automatic)'' when recorded by the charge.refunded webhook - mirrors the provenance convention already used by the editor column.';
COMMENT ON COLUMN "public"."payments"."refund_reference" IS
  'The externally verifiable reference: a Stripe refund id (re_...) or the bank reference used for a manual transfer back.';

-- A refund is only meaningful against a payment that was actually taken, and
-- can't exceed it. Enforced in the database rather than only in the RPC below,
-- because payments is also written by finalize_stripe_payment and (in the next
-- migration) the refund webhook — a constraint holds for all of them.
ALTER TABLE "public"."payments"
  ADD CONSTRAINT "payments_refund_requires_payment"
  CHECK (("refund_amount" IS NULL) OR (("refund_amount" > 0) AND ("paid" = true)));

/**
 * Records a refund against a paid booking.
 *
 * Mirrors rpc_record_bank_transfer_payment's shape deliberately: SECURITY
 * DEFINER with its own admin check, server-derived actor identity (never
 * trusted from the client - same reasoning as verified_by), a required
 * external reference, and a loud RAISE rather than a silent no-op when the
 * booking isn't in a refundable state. That last point matters for the same
 * reason it did there: this is a synchronous admin click, and silently doing
 * nothing would leave someone believing they'd recorded a refund.
 *
 * Deliberately does NOT move any money and does NOT change booking status.
 * It records a refund that has already happened elsewhere (Stripe dashboard,
 * or a manual bank transfer). The Stripe-API-initiated path calls this same
 * function after the API call succeeds, so there is exactly one place where a
 * refund becomes a fact in this database.
 */
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
    -- p_refunded_by is only honoured for service_role callers (the Stripe
    -- webhook, which has no auth.uid() and legitimately needs to attribute
    -- the refund to 'Stripe (automatic)'). An authenticated admin never gets
    -- to choose their own attribution - it is always derived from their JWT,
    -- the same guarantee stamp_audit_log_user_email() enforces for audit rows.
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

ALTER FUNCTION "public"."rpc_record_refund"("p_booking_id" "text", "p_refund_amount" numeric, "p_refund_reference" "text", "p_notes" "text", "p_refunded_by" "text") OWNER TO "postgres";

-- Revoked by name, not just FROM PUBLIC: this schema's ALTER DEFAULT
-- PRIVILEGES history means a PUBLIC-only revoke has silently failed to cover
-- these roles before (see the Gotchas entry on that). anon must never reach a
-- money-mutating function; authenticated needs it for the admin UI.
REVOKE ALL ON FUNCTION "public"."rpc_record_refund"("p_booking_id" "text", "p_refund_amount" numeric, "p_refund_reference" "text", "p_notes" "text", "p_refunded_by" "text") FROM PUBLIC, "anon";
GRANT ALL ON FUNCTION "public"."rpc_record_refund"("p_booking_id" "text", "p_refund_amount" numeric, "p_refund_reference" "text", "p_notes" "text", "p_refunded_by" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rpc_record_refund"("p_booking_id" "text", "p_refund_amount" numeric, "p_refund_reference" "text", "p_notes" "text", "p_refunded_by" "text") TO "service_role";
