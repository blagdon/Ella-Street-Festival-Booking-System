-- Shortens the payment_link token even further. 20260731100000 already
-- swapped the raw ~475-character Stripe Checkout URL for a first-party
-- redirect keyed on the Stripe Checkout Session id (~66 characters) -
-- functional, but the id itself still makes the visible SMS link a
-- cluttered ~110 characters. Swaps the lookup key for an 8-character
-- URL-safe random code instead (48 bits of entropy - 6 random bytes,
-- base64url-encoded), the same DEFAULT-on-every-row pattern
-- `bookings.cancel_token` already uses, getting the link under 50
-- characters total.
--
-- UNIQUE is enforced (belt-and-braces, not a correctness requirement):
-- get-payment-link's `.single()` lookup already fails safe - loudly - on
-- any accidental collision rather than silently misrouting to the wrong
-- booking, and at this app's scale (a small local festival, low
-- thousands of bookings at most) a collision across 2^48 possibilities is
-- not a realistic concern either way.

ALTER TABLE "public"."bookings"
  ADD COLUMN IF NOT EXISTS "payment_link_code" "text"
  DEFAULT (translate(encode(extensions.gen_random_bytes(6), 'base64'), '+/', '-_'));

-- Backfill existing rows (the DEFAULT above only applies to future inserts)
-- so any booking that already has a live payment request out - including
-- one whose SMS was already sent - gets a working code without needing an
-- admin to resend.
UPDATE "public"."bookings"
SET "payment_link_code" = translate(encode(extensions.gen_random_bytes(6), 'base64'), '+/', '-_')
WHERE "payment_link_code" IS NULL;

ALTER TABLE "public"."bookings"
  ADD CONSTRAINT "bookings_payment_link_code_key" UNIQUE ("payment_link_code");
