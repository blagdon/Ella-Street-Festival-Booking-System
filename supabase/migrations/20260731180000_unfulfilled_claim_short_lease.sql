-- rpc_claim_stripe_session_slot's revert path (get-payment-link, on a
-- failed stripe.checkout.sessions.create call) clears stripe_session_
-- claimed_at with a plain inline UPDATE. If that revert itself never runs -
-- the isolate is killed, or the network drops, between the Stripe call
-- failing and the revert committing - the slot stays claimed-but-empty
-- (stripe_session_claimed_at set, stripe_checkout_url still null) for the
-- full p_freshness_seconds window (24h). Nothing self-heals this: no
-- webhook fires, because no Stripe object was ever created. A stallholder
-- clicking their link during that window would see "still being prepared"
-- indefinitely.
--
-- Fix: an unfulfilled claim (stripe_checkout_url still null) is now
-- re-claimable after a much shorter p_unfulfilled_claim_seconds, separate
-- from the 24h freshness window that applies once a real checkout_url has
-- actually been stored. This makes the explicit revert redundant for
-- correctness (though still worth keeping - it lets an immediate retry
-- succeed without waiting out even the short window) rather than load-
-- bearing: the lease itself now expires regardless of whether the revert
-- ever runs.
--
-- 2 minutes (the default below) is ~60x get-payment-link's own
-- CLAIM_WAIT_ATTEMPTS/CLAIM_WAIT_MS wait budget (~2.1s) for a legitimately
-- in-flight claim, so it won't collide with a merely-slow (not crashed)
-- Stripe call.

-- CREATE OR REPLACE does NOT replace a function whose parameter list has
-- changed - Postgres identifies a function by name AND argument types, so
-- adding a third parameter would otherwise create a second overload
-- alongside the original two-argument one, leaving PostgREST unable to pick
-- between them (PGRST203, "Could not choose the best candidate function").
-- The old signature must be dropped explicitly first.
DROP FUNCTION IF EXISTS "public"."rpc_claim_stripe_session_slot"("text", integer);

CREATE OR REPLACE FUNCTION "public"."rpc_claim_stripe_session_slot"(
    "p_payment_link_code" "text",
    "p_freshness_seconds" integer DEFAULT 86400,
    "p_unfulfilled_claim_seconds" integer DEFAULT 120
) RETURNS SETOF "public"."bookings"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  UPDATE public.bookings
  SET stripe_session_claimed_at = now()
  WHERE payment_link_code = p_payment_link_code
    AND status = 'Payment Requested'
    AND (
      stripe_session_claimed_at IS NULL
      OR (
        stripe_checkout_url IS NULL
        AND stripe_session_claimed_at < now() - (p_unfulfilled_claim_seconds || ' seconds')::interval
      )
      OR (
        stripe_checkout_url IS NOT NULL
        AND stripe_session_claimed_at < now() - (p_freshness_seconds || ' seconds')::interval
      )
    )
  RETURNING *;
$$;
