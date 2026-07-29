-- Fixes a real concurrency bug in rpc_claim_stripe_session_slot
-- (20260731120000), caught by its own new atomicity test rather than in
-- production: two genuinely concurrent claims for the SAME never-yet-clicked
-- booking BOTH won.
--
-- Root cause: the original WHERE clause used `stripe_checkout_url IS NULL`
-- as an unconditional "needs claiming" signal, layered on top of
-- stripe_payment_requested_at as the freshness check. But
-- create-checkout-session ALREADY sets stripe_payment_requested_at to now()
-- at request time, for its own unrelated double-click guard (preventing an
-- admin's own double-click from re-sending the notification, nothing to do
-- with Stripe session creation). So on the very first click after a
-- request/resend, BOTH concurrent calls saw stripe_checkout_url IS NULL as
-- true regardless of each other's writes - there was no real lock, just two
-- conditions that happened to both start out true.
--
-- Fix: a column this RPC exclusively owns, touched by nothing else in the
-- app. No IS NULL bypass tied to stripe_checkout_url at all - "never
-- claimed" (NULL) and "stale" are both just checked against
-- stripe_session_claimed_at's own freshness, so the very first concurrent
-- pair now serializes correctly: Postgres blocks the second UPDATE on the
-- row lock, and once unblocked it re-evaluates its WHERE clause against the
-- first UPDATE's now-committed, freshly-claimed row and finds no match.

ALTER TABLE "public"."bookings"
  ADD COLUMN IF NOT EXISTS "stripe_session_claimed_at" timestamp with time zone;

COMMENT ON COLUMN "public"."bookings"."stripe_session_claimed_at" IS
  'Internal bookkeeping for rpc_claim_stripe_session_slot only - do not read/write this from anywhere else. Tracks when a lazy Stripe Checkout Session creation was last claimed, independent of stripe_payment_requested_at (which create-checkout-session owns for its own double-click guard).';

CREATE OR REPLACE FUNCTION "public"."rpc_claim_stripe_session_slot"(
    "p_payment_link_code" "text",
    "p_freshness_seconds" integer DEFAULT 86400
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
      OR stripe_session_claimed_at < now() - (p_freshness_seconds || ' seconds')::interval
    )
  RETURNING *;
$$;
