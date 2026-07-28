-- New SMS template for the "payment request" notification, alongside the
-- existing "payment_requested" email sent from create-checkout-session (both
-- the initial chargeable-confirm and a "Resend Payment Request").
--
-- Deliberately does NOT carry the Stripe checkout link itself: session.url
-- is a ~400+ character URL (Stripe's Checkout Session links embed a large
-- encoded state fragment), which would bill this text as 6-8 parts instead
-- of the 1-2 parts every other SMS added this session settled on. Points to
-- email instead, where the real, clickable link already lives.
--
-- ON CONFLICT DO NOTHING so re-running never clobbers an admin's own edit.

INSERT INTO "public"."sms_templates" ("id", "body", "description") VALUES
  ('payment_requested',
   'Hi {{owner_name}}, a payment request for {{cost}} has been sent for your Ella Street Festival stall ({{booking_id}}). Check your email for the secure payment link. festival.stalls@ellastreet.co.uk',
   'Optional text sent alongside the payment_requested email, from the Confirm modal''s "also send a text" tickbox (chargeable path) or a resend. Placeholders: {{owner_name}}, {{business_name}}, {{booking_id}}, {{cost}}. Deliberately omits the payment link itself (too long for SMS) — points to email instead.')
ON CONFLICT ("id") DO NOTHING;
