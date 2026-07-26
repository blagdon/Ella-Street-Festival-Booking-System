-- Shorten the seeded SMS templates so they bill as ONE part, not two.
--
-- Caught by a new test in tests/sms-send.test.mjs that fills each template
-- with worst-case placeholder values and counts billed segments. All three
-- seeded bodies came out at 2 parts:
--
--   booking_confirmed  168 chars -> 2 parts
--   booking_rejected   198 chars -> 2 parts
--   booking_cancelled  196 chars -> 2 parts
--
-- GSM-7 fits 160 characters in a single part, and every part is billed per
-- recipient. Confirmation is the most-sent message in the system, so this was
-- silently doubling the cost of the whole feature — roughly £9.30 rather than
-- £4.65 per 150 confirmations at 3.1p a part. The wording is trimmed (the
-- 32-character contact address is kept, since the alphanumeric sender ID is
-- one-way and recipients need some route back) leaving 15-31 characters of
-- headroom for longer names.
--
-- IMPORTANT: each UPDATE is guarded on the body still matching the exact text
-- the earlier migrations seeded. A template an admin has since reworded in the
-- SMS Template Manager is left completely alone — this fixes our defaults, it
-- does not overwrite anyone's edits.

UPDATE "public"."sms_templates"
SET "body" = 'Hi {{owner_name}}, your Ella Street Festival stall is confirmed. Replies not monitored: festival.stalls@ellastreet.co.uk',
    "updated_at" = now()
WHERE "id" = 'booking_confirmed'
  AND "body" = 'Hi {{owner_name}}, your Ella Street Festival stall booking is confirmed. Not monitored for replies - email festival.stalls@ellastreet.co.uk with any questions.';

UPDATE "public"."sms_templates"
SET "body" = 'Hi {{owner_name}}, sorry - no stall available at Ella Street Festival this year. Replies not monitored: festival.stalls@ellastreet.co.uk',
    "updated_at" = now()
WHERE "id" = 'booking_rejected'
  AND "body" = 'Hi {{owner_name}}, unfortunately we cannot offer you a stall at the Ella Street Festival this year. Replies are not monitored - email festival.stalls@ellastreet.co.uk if you have questions.';

UPDATE "public"."sms_templates"
SET "body" = 'Hi {{owner_name}}, Ella Street Festival booking {{booking_id}} is cancelled. Replies not monitored: festival.stalls@ellastreet.co.uk',
    "updated_at" = now()
WHERE "id" = 'booking_cancelled'
  AND "body" = 'Hi {{owner_name}}, your Ella Street Festival stall booking {{booking_id}} has been cancelled. Replies are not monitored - email festival.stalls@ellastreet.co.uk if this is unexpected.';
