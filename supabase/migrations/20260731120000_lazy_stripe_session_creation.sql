-- Supports moving Stripe Checkout Session creation from request-time
-- (create-checkout-session) to click-time (get-payment-link) - so a
-- stallholder who waits days before clicking their payment link always
-- lands on a session created minutes ago, rather than one that expired
-- against Stripe's 24h default while nobody was looking.
--
-- Two pieces:
--
-- 1. stripe_requested_cost: the amount actually agreed at request/resend
--    time, frozen from that moment on. stall_cost is a live, general-purpose
--    field the Update Details page can edit at any time for record-keeping -
--    if a lazily-created session read stall_cost directly, an unrelated
--    admin edit made while a payment request is outstanding would silently
--    change what the stallholder gets charged when they finally click.
--    stripe_requested_cost is set once per request/resend and never touched
--    by anything else, so what was quoted is what gets charged, regardless
--    of what stall_cost says by the time they pay.
--
-- 2. rpc_claim_stripe_session_slot: get-payment-link can no longer treat
--    "is the stored session still fresh" as a plain read - once it creates
--    real Stripe sessions, two near-simultaneous clicks (a slow double-tap,
--    two open tabs) must not both decide to create one. Same locking
--    strategy this schema already uses for claim_pending_sms/
--    claim_pending_emails: a single atomic UPDATE...RETURNING. Only a row
--    that is still 'Payment Requested' AND has no fresh session gets
--    claimed (its stripe_payment_requested_at bumped to now()); a
--    concurrent second call arriving even milliseconds later sees that
--    fresh timestamp and matches nothing, so it does not also claim.
--
--    The caller (get-payment-link) must revert stripe_payment_requested_at
--    if the Stripe API call it makes after claiming actually fails -
--    otherwise the slot looks freshly-claimed forever with no real session
--    behind it. See that function for the revert-on-failure and the
--    bounded retry it does if a *second* click races in during the narrow
--    window where a first click has claimed the slot but Stripe hasn't
--    responded yet.

ALTER TABLE "public"."bookings"
  ADD COLUMN IF NOT EXISTS "stripe_requested_cost" numeric;

COMMENT ON COLUMN "public"."bookings"."stripe_requested_cost" IS
  'The stall fee frozen at the moment payment was last requested/resent - what a lazily-created Stripe Checkout Session actually charges. Deliberately separate from stall_cost (which Update Details can edit any time) so an unrelated later edit cannot silently change what an outstanding payment link charges.';

-- Backfill: every booking currently sitting in Payment Requested already has
-- a real, eagerly-created session whose price was whatever stall_cost was at
-- that time - stall_cost has not been touched by this migration, so it is
-- still the correct frozen value to carry forward.
UPDATE "public"."bookings"
SET "stripe_requested_cost" = "stall_cost"
WHERE "status" = 'Payment Requested' AND "stripe_requested_cost" IS NULL;

CREATE OR REPLACE FUNCTION "public"."rpc_claim_stripe_session_slot"(
    "p_payment_link_code" "text",
    "p_freshness_seconds" integer DEFAULT 86400
) RETURNS SETOF "public"."bookings"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  UPDATE public.bookings
  SET stripe_payment_requested_at = now()
  WHERE payment_link_code = p_payment_link_code
    AND status = 'Payment Requested'
    AND (
      stripe_checkout_url IS NULL
      OR stripe_payment_requested_at IS NULL
      OR stripe_payment_requested_at < now() - (p_freshness_seconds || ' seconds')::interval
    )
  RETURNING *;
$$;

ALTER FUNCTION "public"."rpc_claim_stripe_session_slot"("p_payment_link_code" "text", "p_freshness_seconds" integer) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."rpc_claim_stripe_session_slot"("p_payment_link_code" "text", "p_freshness_seconds" integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."rpc_claim_stripe_session_slot"("p_payment_link_code" "text", "p_freshness_seconds" integer) FROM "anon", "authenticated";
GRANT ALL ON FUNCTION "public"."rpc_claim_stripe_session_slot"("p_payment_link_code" "text", "p_freshness_seconds" integer) TO "service_role";
