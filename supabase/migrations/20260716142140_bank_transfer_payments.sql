-- Manual bank-transfer payments, alongside the existing fully-automated
-- Stripe flow. No new booking statuses, no new Kanban columns - a booking
-- still just sits in 'Payment Requested' until *something* marks it
-- Confirmed: the Stripe webhook (finalize_stripe_payment, existing), or now
-- this new manual RPC for a bank transfer an admin has personally verified.

-- Additive, nullable columns - no existing row/query is affected until
-- something explicitly sets them.
ALTER TABLE "public"."payments"
    ADD COLUMN IF NOT EXISTS "payment_method" "text",
    ADD COLUMN IF NOT EXISTS "payment_reference" "text",
    ADD COLUMN IF NOT EXISTS "verified_by" "text",
    ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone,
    ADD COLUMN IF NOT EXISTS "notes" "text";

ALTER TABLE "public"."payments"
    ADD CONSTRAINT "payments_payment_method_check"
    CHECK (("payment_method" IS NULL) OR ("payment_method" = ANY (ARRAY['stripe'::"text", 'bank_transfer'::"text"])));

-- One-off backfill: every existing paid row was written by
-- finalize_stripe_payment (the only path that has ever set paid=true before
-- this migration), and that function has always prefixed bank_ref with
-- 'Stripe: ' - a reliable signal for classifying historical rows.
UPDATE "public"."payments"
SET "payment_method" = 'stripe'
WHERE "payment_method" IS NULL AND "bank_ref" LIKE 'Stripe:%';


-- finalize_stripe_payment: additive change only. Now also stamps
-- payment_method='stripe' so both payment paths populate the same
-- classification column going forward. No other behavior change -
-- existing grants (service_role only) are untouched by CREATE OR REPLACE.
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
        INSERT INTO payments (booking_id, paid, date_paid, bank_ref, editor, payment_method)
        VALUES (p_booking_id, true, CURRENT_DATE, 'Stripe: ' || p_payment_intent_id, 'Stripe (automatic)', 'stripe')
        ON CONFLICT (booking_id) DO UPDATE
        SET paid = true,
            date_paid = CURRENT_DATE,
            bank_ref = EXCLUDED.bank_ref,
            editor = EXCLUDED.editor,
            payment_method = 'stripe',
            updated_at = now();
    END IF;
END;
$$;


-- New RPC: the manual counterpart to finalize_stripe_payment. Unlike that
-- function (called only by the stripe-webhook Edge Function with the
-- service-role key), there is no server-only "bank webhook" - an admin's
-- own authenticated browser session calls this directly, so it does its
-- own internal admin-role check, the same pattern already used by
-- rpc_set_booking_locations, rather than relying solely on a
-- service-role-only grant.
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
    IF NOT EXISTS (
        SELECT 1 FROM user_roles WHERE id = auth.uid() AND role = 'admin'
    ) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    IF p_payment_reference IS NULL OR trim(p_payment_reference) = '' THEN
        RAISE EXCEPTION 'Payment reference is required.';
    END IF;

    SELECT email INTO v_admin_email FROM user_roles WHERE id = auth.uid();

    -- Same status guard as finalize_stripe_payment, but a deliberately
    -- different outcome when it doesn't match: that function silently
    -- no-ops, which is correct for a retried webhook with no human
    -- watching. This is a direct, synchronous, one-shot admin click -
    -- silently doing nothing would leave the admin believing they'd
    -- recorded a payment when nothing actually happened.
    UPDATE bookings
    SET status = 'Confirmed',
        date_confirmed = now()
    WHERE id = p_booking_id AND status = 'Payment Requested';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Booking % is not awaiting payment (status must be ''Payment Requested'').', p_booking_id;
    END IF;

    INSERT INTO payments (
        booking_id, paid, date_paid, bank_ref, editor,
        payment_method, payment_reference, verified_by, verified_at, notes
    )
    VALUES (
        p_booking_id, true, CURRENT_DATE, 'Bank transfer: ' || p_payment_reference, COALESCE(v_admin_email, 'Admin'),
        'bank_transfer', p_payment_reference, COALESCE(v_admin_email, 'Admin'), now(), p_notes
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

ALTER FUNCTION "public"."rpc_record_bank_transfer_payment"("p_booking_id" "text", "p_payment_reference" "text", "p_notes" "text") OWNER TO "postgres";

-- Same ALTER DEFAULT PRIVILEGES gap finalize_stripe_payment's own migration
-- (20260715141600) already documents - new functions are auto-granted to
-- anon/authenticated at creation time regardless of intent, so anon must be
-- explicitly revoked rather than relying only on the internal role check.
REVOKE ALL ON FUNCTION "public"."rpc_record_bank_transfer_payment"("p_booking_id" "text", "p_payment_reference" "text", "p_notes" "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."rpc_record_bank_transfer_payment"("p_booking_id" "text", "p_payment_reference" "text", "p_notes" "text") FROM "anon";
GRANT ALL ON FUNCTION "public"."rpc_record_bank_transfer_payment"("p_booking_id" "text", "p_payment_reference" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rpc_record_bank_transfer_payment"("p_booking_id" "text", "p_payment_reference" "text", "p_notes" "text") TO "service_role";


-- Update payment_requested to offer both payment options (previously
-- card-only). Built on top of the template's actual current live content
-- (the "Pay Now"/"Cancel Booking" link-text version - confirmed by reading
-- it directly rather than assuming, since this row is admin-editable via
-- email_admin.html and had already diverged from the original seed
-- migration's plainer text) - existing wording/links are preserved
-- unchanged; only the new bank-transfer section and the required sentence
-- are inserted. New placeholders: {{bank_account_name}}, {{bank_sort_code}},
-- {{bank_account_number}} (sourced from the three new settings rows below,
-- never hardcoded), {{payment_reference}} (= the booking id, supplied by
-- create-checkout-session same as {{booking_id}}).
UPDATE "public"."email_templates"
SET "body_html" = '<p>Hi {{owner_name}},</p><p>Your stall booking <strong>{{booking_id}}</strong> for <strong>{{business_name}}</strong> has been approved. The stall fee is <strong>{{cost}}</strong>.</p><p>You can pay in either of the following ways:</p><p><strong>Option 1 – Pay online by card</strong><br>Please complete payment using the secure link below:</p><p><a href="{{payment_link}}">Pay Now</a></p><p><strong>Option 2 – Bank Transfer</strong><br>Account Name: {{bank_account_name}}<br>Sort Code: {{bank_sort_code}}<br>Account Number: {{bank_account_number}}<br>Payment Reference: <strong>{{payment_reference}}</strong><br>Please use this exact reference so we can match your payment to your booking.</p><p><strong>Your booking will not be confirmed until payment has been received and verified by an administrator.</strong></p><p>If you no longer wish to trade, you can cancel your booking here: <a href="{{cancel_link}}">Cancel Booking</a></p><p>Thanks,<br>The Team</p>'
WHERE "id" = 'payment_requested';


-- Seed rows for the three new bank-detail settings - same "never hardcoded,
-- settings-table only" mechanism as every other credential/detail in this
-- app. Empty until an admin fills them in via the new settings.html card.
-- Deliberately NOT added to the "Allow public anon to read non-sensitive
-- settings" policy's key whitelist (20260714132316) - same posture as the
-- existing unrelated bank_details key: only ever read server-side
-- (create-checkout-session, using the service-role key, which bypasses
-- RLS) or by an authenticated admin (covered by the existing "Allow admins
-- full access to settings" policy).
INSERT INTO "public"."settings" ("key", "value") VALUES
    ('bank_account_name', ''),
    ('bank_sort_code', ''),
    ('bank_account_number', '')
ON CONFLICT ("key") DO NOTHING;
