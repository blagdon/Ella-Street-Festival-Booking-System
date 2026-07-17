-- Two vestigial anon/authenticated function grants, plus the systemic gap
-- behind both (this project's schema-level ALTER DEFAULT PRIVILEGES
-- auto-grants EXECUTE on every new function to anon/authenticated at
-- creation time, regardless of intent - already patched object-by-object in
-- 20260715123703_fix_stripe_anon_authenticated_grants.sql and
-- 20260716142140_bank_transfer_payments.sql; this is the third time it's
-- bitten this project, so this migration fixes the default itself).
--
-- cancel_booking_secure(p_token, p_reason): the cancel-booking Edge Function
-- verifies a Cloudflare Turnstile token, THEN calls this RPC with the
-- service-role key - but the RPC itself was still directly callable by
-- anon/authenticated via PostgREST, with no CAPTCHA involved, contradicting
-- the "Turnstile moved server-side" design. Confirmed the only caller
-- anywhere in this repo is that Edge Function's service-role client (grep
-- supabase/functions/cancel-booking/index.ts). Real-world impact is low -
-- p_token is a gen_random_uuid() cancel_token, unguessable, so this isn't an
-- exploitable IDOR - but a direct caller could skip the CAPTCHA entirely,
-- which the anon grant should never have allowed.
--
-- get_next_booking_id(p_prefix): takes a table-level SHARE ROW EXCLUSIVE
-- lock on bookings, and leaks the current booking counter. Booking
-- submission moved server-side into submit-booking's own service-role call
-- (supabase/functions/submit-booking/index.ts) some time ago; the
-- client-side generateNextId() helpers in js/page-food-booking.js,
-- js/page-food-booking-dev.js, and js/page-general-booking.js that used to
-- call this directly as anon are dead code now (defined, never invoked) -
-- confirmed by grep, not touched by this migration since removing dead code
-- is a separate concern from the grant itself. The anon/authenticated grant
-- was already vestigial.
--
-- REVOKE is a no-op (not an error) for a grant that doesn't exist, so both
-- statements below are safe to run regardless of the exact grant state.

REVOKE ALL ON FUNCTION "public"."cancel_booking_secure"("p_token" "uuid", "p_reason" "text") FROM "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."get_next_booking_id"("p_prefix" "text") FROM "anon", "authenticated";

-- The systemic fix: stop auto-granting anon on every new function/table/
-- sequence going forward. Non-retroactive - this only changes what happens
-- at CREATE time from now on, it doesn't touch any existing grant (the two
-- REVOKEs above still needed doing by hand). Any future function/view that
-- genuinely needs anon access (the public_bookings_info/public_performer_info
-- pattern) needs an explicit GRANT in its own migration from here on -
-- already how those were built, so this formalizes existing practice rather
-- than adding new friction.
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON FUNCTIONS FROM "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "anon";
