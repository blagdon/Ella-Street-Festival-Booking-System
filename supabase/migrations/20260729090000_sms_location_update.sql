-- SMS template for the location-allocation notification, alongside the
-- existing "location_update" email sent from the Location Manager (both the
-- per-row "Send Location" button and the bulk "Send Bulk Emails" button).
--
-- Sized to fit a single GSM-7 part (110 chars filled, 50 chars headroom) at
-- worst-case owner_name length with a single pitch; still fits one part
-- (121 chars) with two pitches assigned. Unlike {{reason}}, {{location_id}}
-- is not truncated — an admin assigning several pitches to one stall is a
-- real, meaningful case, not a rambling free-text field to guard against.
--
-- ON CONFLICT DO NOTHING so re-running never clobbers wording an admin has
-- since edited in the SMS Template Manager.

INSERT INTO "public"."sms_templates" ("id", "body", "description") VALUES
  ('location_update',
   'Hi {{owner_name}}, your Ella Street Festival pitch is now {{location_id}}. festival.stalls@ellastreet.co.uk',
   'Optional text sent from Location Manager (individual "Send Location" or bulk "Send Bulk Emails") alongside the location_update email. Placeholders: {{owner_name}}, {{business_name}}, {{booking_id}}, {{location_id}} (the assigned pitch(es), comma-separated).')
ON CONFLICT ("id") DO NOTHING;
