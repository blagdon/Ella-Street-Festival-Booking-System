-- Follow-up fix: the previous migration's REVOKE statements for the two
-- Stripe RPCs only targeted PUBLIC, and the stripe_webhook_events table had
-- no REVOKE at all (relying on "RLS enabled + zero policies = default
-- deny"). Confirmed live via tests/stripe-payment.test.mjs against the
-- disposable test project: anon could still SELECT the ledger table (RLS
-- silently returned zero rows rather than erroring, since anon apparently
-- holds a direct table grant from this project's schema-level default
-- privileges, separate from the PUBLIC pseudo-role) and could still EXECUTE
-- both RPCs directly. REVOKE ... FROM PUBLIC does not touch a role's own
-- direct grant picked up via ALTER DEFAULT PRIVILEGES at creation time, so
-- anon/authenticated need to be revoked explicitly, by name.
--
-- REVOKE is a no-op (not an error) for a grant that doesn't exist, so this
-- is safe to run regardless of the exact grant state.

REVOKE ALL ON TABLE "public"."stripe_webhook_events" FROM "anon", "authenticated";

REVOKE ALL ON FUNCTION "public"."mark_stripe_payment_received"("p_booking_id" "text", "p_payment_intent_id" "text") FROM "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."finalize_stripe_confirmation"("p_booking_id" "text") FROM "anon", "authenticated";
