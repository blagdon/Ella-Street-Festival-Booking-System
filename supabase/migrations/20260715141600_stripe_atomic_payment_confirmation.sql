-- Removes the 'Paid' status. It existed only as a recoverable intermediate
-- state for a crash between mark_stripe_payment_received() and
-- finalize_stripe_confirmation() (two separate top-level RPC calls from the
-- webhook). Requested follow-up: collapse those into one atomic RPC instead,
-- so the webhook goes straight from 'Payment Requested' to 'Confirmed' with
-- no intermediate status to ever get stuck in — a single SECURITY DEFINER
-- function call is one Postgres transaction, so either both the status
-- update and the payments upsert happen, or neither does (a crash/error
-- leaves the booking exactly at 'Payment Requested', which the webhook
-- (Stripe retries failed deliveries) or "Resend Payment Request" can recover
-- from without any dedicated recovery button).

DROP FUNCTION IF EXISTS "public"."mark_stripe_payment_received"("p_booking_id" "text", "p_payment_intent_id" "text");
DROP FUNCTION IF EXISTS "public"."finalize_stripe_confirmation"("p_booking_id" "text");


-- Single atomic replacement. No-ops harmlessly (0 rows updated, no error) if
-- the booking isn't currently 'Payment Requested' — covers a duplicate/
-- delayed webhook delivery arriving after the booking already moved on (was
-- Cancelled in the meantime, or a prior delivery of the same event already
-- succeeded). This status guard, not the stripe_webhook_events ledger, is
-- the real idempotency boundary for the payment-processing side (the ledger
-- only dedupes the confirmation EMAIL send, unchanged from before).
CREATE OR REPLACE FUNCTION "public"."finalize_stripe_payment"(
    "p_booking_id" "text",
    "p_payment_intent_id" "text"
) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    UPDATE bookings
    SET status = 'Confirmed',
        stripe_payment_intent_id = p_payment_intent_id,
        date_confirmed = now()
    WHERE id = p_booking_id AND status = 'Payment Requested';

    IF FOUND THEN
        INSERT INTO payments (booking_id, paid, date_paid, bank_ref, editor)
        VALUES (p_booking_id, true, CURRENT_DATE, 'Stripe: ' || p_payment_intent_id, 'Stripe (automatic)')
        ON CONFLICT (booking_id) DO UPDATE
        SET paid = true,
            date_paid = CURRENT_DATE,
            bank_ref = EXCLUDED.bank_ref,
            editor = EXCLUDED.editor,
            updated_at = now();
    END IF;
END;
$$;

ALTER FUNCTION "public"."finalize_stripe_payment"("p_booking_id" "text", "p_payment_intent_id" "text") OWNER TO "postgres";

-- REVOKE FROM PUBLIC alone is not enough on this project — schema-level
-- ALTER DEFAULT PRIVILEGES grants new functions directly to anon/
-- authenticated at creation time (the gap found and fixed for the original
-- two RPCs in 20260715123703). Revoking by name from the start here avoids
-- needing a second forward-fix migration for this one.
REVOKE ALL ON FUNCTION "public"."finalize_stripe_payment"("p_booking_id" "text", "p_payment_intent_id" "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."finalize_stripe_payment"("p_booking_id" "text", "p_payment_intent_id" "text") FROM "anon", "authenticated";
GRANT ALL ON FUNCTION "public"."finalize_stripe_payment"("p_booking_id" "text", "p_payment_intent_id" "text") TO "service_role";
