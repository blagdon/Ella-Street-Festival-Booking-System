-- Stripe Checkout payment collection.
--
-- New bookings columns to track the Stripe side of a payment request; a new
-- stripe_webhook_events ledger used ONLY to dedupe the webhook's email send
-- (the two RPCs below are already safely re-callable on their own — see
-- their comments); two SECURITY DEFINER RPCs, callable only by the
-- service_role (i.e. only the stripe-webhook Edge Function, using the
-- service-role key, ever calls these — never a user JWT); and a seed row for
-- the new "payment_requested" email template (email_templates has no
-- "create new" UI, only an editor for existing rows, so this must be seeded
-- here to be usable at all).
--
-- Deliberately does NOT touch booking_locations, rpc_set_booking_locations,
-- or anything location-allocation-related — that stays fully separate.

ALTER TABLE "public"."bookings"
    ADD COLUMN IF NOT EXISTS "stripe_checkout_session_id" "text",
    ADD COLUMN IF NOT EXISTS "stripe_payment_intent_id" "text",
    ADD COLUMN IF NOT EXISTS "stripe_payment_requested_at" timestamp with time zone;


-- Pure email-send dedup ledger for the Stripe webhook. RLS enabled with zero
-- policies: service_role bypasses RLS entirely (that's the only caller),
-- so anon/authenticated get no access at all by default, matching the
-- "nothing else should ever touch this" intent (same posture as
-- email_queue/user_roles being admin/service-only, just via RLS-default-deny
-- instead of an explicit policy, since no human-facing UI ever needs this).
CREATE TABLE IF NOT EXISTS "public"."stripe_webhook_events" (
    "event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("event_id")
);

ALTER TABLE "public"."stripe_webhook_events" OWNER TO "postgres";
ALTER TABLE "public"."stripe_webhook_events" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."stripe_webhook_events" TO "service_role";


-- Step 1 of the two-step webhook-side transition. Deliberately a SEPARATE
-- top-level call from finalize_stripe_confirmation() below (not one
-- transaction spanning both) — a crash between the two genuinely leaves a
-- real, visible, recoverable "Paid" booking rather than an unreachable
-- intermediate state, which is what the Kanban "Mark as Confirmed" recovery
-- action (js/api.js's recoverStuckPaidBooking) exists for.
--
-- No-ops harmlessly (0 rows updated, no error) if the booking isn't
-- currently 'Payment Requested' — covers a duplicate/delayed webhook
-- delivery arriving after the booking already moved on (e.g. was Cancelled
-- in the meantime, or a prior delivery of the same event already
-- succeeded). This status guard, not the stripe_webhook_events ledger, is
-- the real idempotency boundary for the payment-processing side.
CREATE OR REPLACE FUNCTION "public"."mark_stripe_payment_received"(
    "p_booking_id" "text",
    "p_payment_intent_id" "text"
) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    UPDATE bookings
    SET status = 'Paid',
        stripe_payment_intent_id = p_payment_intent_id
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

ALTER FUNCTION "public"."mark_stripe_payment_received"("p_booking_id" "text", "p_payment_intent_id" "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."mark_stripe_payment_received"("p_booking_id" "text", "p_payment_intent_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_stripe_payment_received"("p_booking_id" "text", "p_payment_intent_id" "text") TO "service_role";


-- Step 2. No-ops if the booking isn't currently 'Paid' (e.g. this exact
-- webhook event already ran both steps before, or something else moved the
-- booking on in between).
CREATE OR REPLACE FUNCTION "public"."finalize_stripe_confirmation"(
    "p_booking_id" "text"
) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    UPDATE bookings
    SET status = 'Confirmed',
        date_confirmed = now()
    WHERE id = p_booking_id AND status = 'Paid';
END;
$$;

ALTER FUNCTION "public"."finalize_stripe_confirmation"("p_booking_id" "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."finalize_stripe_confirmation"("p_booking_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finalize_stripe_confirmation"("p_booking_id" "text") TO "service_role";


-- Seed the new template row (admin can edit subject/body afterwards via
-- email_admin.html exactly like any other template).
INSERT INTO "public"."email_templates" ("id", "subject", "body_html", "description")
VALUES (
    'payment_requested',
    'Payment required for your stall booking ({{booking_id}})',
    '<p>Hi {{owner_name}},</p><p>Your stall booking <strong>{{booking_id}}</strong> for <strong>{{business_name}}</strong> has been approved. The stall fee is <strong>{{cost}}</strong>.</p><p>Please complete payment using the secure link below:</p><p><a href="{{payment_link}}">{{payment_link}}</a></p><p>Thanks,<br>The Team</p>',
    'Sent when an admin requests payment for a Pre-Confirmed booking (and again on resend). Placeholders: {{owner_name}}, {{business_name}}, {{booking_id}}, {{cost}}, {{payment_link}}.'
)
ON CONFLICT ("id") DO NOTHING;
