-- Adds {{cancel_link}} to every SMS the stallholder can still act on, and
-- {{cost}}/{{bank_details}} to the confirmation text — requested so a
-- stallholder who only reads texts (not email) still has the bank transfer
-- details and a working way to cancel.
--
-- booking_rejected and booking_cancelled are deliberately left untouched:
-- a rejected or already-cancelled booking has nothing left to cancel, so a
-- cancel link there would be pointless (and, for the cancelled case, the
-- cancel_token has already been nulled out by the cancel/reject RPC — see
-- 20260714132316_baseline_schema.sql / 20260715183903_remove_on_hold_status.sql
-- — so the link would resolve to nothing anyway).
--
-- These three now deliberately exceed one billed GSM-7 part (2 parts each at
-- realistic worst-case lengths) — an explicit, approved trade-off, unlike
-- the earlier single-part budgeting work in 20260726100000/20260727080000.
-- js/shared.js's getSmsFromTemplate() gains {{cancel_link}}/{{bank_details}}
-- substitution to match; submit-booking/index.ts's sendReceivedSms() gains
-- {{cancel_link}} for the same reason, mirroring sendReceivedEmail()'s
-- existing cancel-link lookup.
--
-- Same guarded UPDATE pattern as every prior sms_templates migration: only
-- replaces a row if it still holds the exact text the last migration seeded,
-- so an admin's own rewording in the SMS Template Manager is never
-- overwritten.

UPDATE "public"."sms_templates"
SET "body" = 'Hi {{owner_name}}, your Ella Street Festival stall is confirmed. Cost: {{cost}}. {{bank_details}}. Cancel: {{cancel_link}} Replies not monitored: festival.stalls@ellastreet.co.uk',
    "description" = 'Sent when a booking moves to Confirmed. Placeholders: {{owner_name}}, {{business_name}}, {{booking_id}}, {{cost}}, {{bank_details}} (account name/sort code/account number), {{cancel_link}}.',
    "updated_at" = now()
WHERE "id" = 'booking_confirmed'
  AND "body" = 'Hi {{owner_name}}, your Ella Street Festival stall is confirmed. Replies not monitored: festival.stalls@ellastreet.co.uk';

UPDATE "public"."sms_templates"
SET "body" = 'Hi {{owner_name}}, we''ve received your Ella Street Festival application. Reference: {{booking_id}}. Cancel: {{cancel_link}} festival.stalls@ellastreet.co.uk',
    "description" = 'Sent automatically when a stallholder submits a booking, alongside the "application_received" email. No opt-in tickbox — fires whenever a phone number was given. Placeholders: {{owner_name}}, {{business_name}}, {{booking_id}} (the reference number), {{cancel_link}}.',
    "updated_at" = now()
WHERE "id" = 'booking_received'
  AND "body" = 'Hi {{owner_name}}, we''ve received your Ella Street Festival application. Reference: {{booking_id}}. festival.stalls@ellastreet.co.uk';

UPDATE "public"."sms_templates"
SET "body" = 'Hi {{owner_name}}, your Ella Street Festival pitch is now {{location_id}}. Cancel: {{cancel_link}} festival.stalls@ellastreet.co.uk',
    "description" = 'Optional text sent from Location Manager (individual "Send Location" or bulk "Send Bulk Emails") alongside the location_update email. Placeholders: {{owner_name}}, {{business_name}}, {{booking_id}}, {{location_id}} (the assigned pitch(es), comma-separated), {{cancel_link}}.',
    "updated_at" = now()
WHERE "id" = 'location_update'
  AND "body" = 'Hi {{owner_name}}, your Ella Street Festival pitch is now {{location_id}}. festival.stalls@ellastreet.co.uk';
