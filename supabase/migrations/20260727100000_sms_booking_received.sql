-- SMS template for the "booking received" confirmation sent on public
-- submission (submit-booking Edge Function), alongside the existing
-- "application_received" email.
--
-- Unlike the admin confirm/reject/cancel texts, this one has no opt-in
-- tickbox: submission is public and unauthenticated, so there is no admin
-- present to tick anything. It fires whenever the stallholder supplied a
-- phone number, the same way the email fires whenever they supplied an
-- email address — see sendReceivedSms() in submit-booking/index.ts.
--
-- Sized to fit a single GSM-7 part (160 chars) even at worst-case
-- owner_name + booking_id length — 145 chars filled, 15 chars of headroom —
-- so this can't repeat the double-billing bug fixed in
-- 20260726100000_sms_templates_single_part.sql. Includes the contact address
-- since the alphanumeric sender ID is one-way.
--
-- ON CONFLICT DO NOTHING so re-running never clobbers wording an admin has
-- since edited in the SMS Template Manager.

INSERT INTO "public"."sms_templates" ("id", "body", "description") VALUES
  ('booking_received',
   'Hi {{owner_name}}, we''ve received your Ella Street Festival application. Reference: {{booking_id}}. festival.stalls@ellastreet.co.uk',
   'Sent automatically when a stallholder submits a booking, alongside the "application_received" email. No opt-in tickbox — fires whenever a phone number was given. Placeholders: {{owner_name}}, {{business_name}}, {{booking_id}} (the reference number).')
ON CONFLICT ("id") DO NOTHING;
