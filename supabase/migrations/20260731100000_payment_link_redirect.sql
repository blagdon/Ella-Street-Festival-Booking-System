-- Adds a short first-party redirect link (pay.html?token=<stripe session
-- id>) so the payment_requested SMS can finally carry a real payment link.
-- The raw Stripe Checkout Session URL is ~400-475 characters (measured on a
-- real session) - far too long for SMS (would bill 4+ parts on its own),
-- which is why 20260731090000 deliberately left it out. Instead we now
-- store the full URL once at creation time and hand out our own short link
-- that redirects to it - the same shortening trick cancel_link already uses
-- for cancellations (our own domain + a short token, not the long URL
-- itself). See supabase/functions/get-payment-link/index.ts + pay.html for
-- the redirect itself.
--
-- The lookup token is the Stripe Checkout Session id itself, not a new
-- random UUID - it's already a high-entropy, Stripe-generated identifier
-- that's no more sensitive than what's already emailed out today (the
-- payment_requested email already embeds this same id inside session.url).

ALTER TABLE "public"."bookings" ADD COLUMN IF NOT EXISTS "stripe_checkout_url" "text";

-- Same guarded UPDATE pattern as every prior sms_templates migration: only
-- replaces the row if it still holds the exact text 20260731090000 seeded,
-- so an admin's own rewording in the SMS Template Manager is never
-- overwritten.
UPDATE "public"."sms_templates"
SET "body" = 'Hi {{owner_name}}, a payment request for {{cost}} has been sent for your Ella Street Festival stall ({{booking_id}}). Pay: {{payment_link}} festival.stalls@ellastreet.co.uk',
    "description" = 'Optional text sent alongside the payment_requested email, from the Confirm modal''s "also send a text" tickbox (chargeable path) or a resend. Placeholders: {{owner_name}}, {{business_name}}, {{booking_id}}, {{cost}}, {{payment_link}} (short first-party redirect to the Stripe Checkout Session - NOT the raw Stripe URL, which is too long for SMS).',
    "updated_at" = now()
WHERE "id" = 'payment_requested'
  AND "body" = 'Hi {{owner_name}}, a payment request for {{cost}} has been sent for your Ella Street Festival stall ({{booking_id}}). Check your email for the secure payment link. festival.stalls@ellastreet.co.uk';
