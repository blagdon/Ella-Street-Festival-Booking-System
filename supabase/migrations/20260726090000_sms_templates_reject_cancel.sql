-- SMS templates for the rejection and cancellation paths.
--
-- The Kanban/Summary reject and cancel actions gain an optional "also text
-- them" tickbox (mirroring the one already on the confirm modal), and
-- getSmsFromTemplate() throws if the template row is missing — so these have
-- to exist before that UI can be used.
--
-- Note the asymmetry with email, which is deliberate:
--   - Rejection already sends an email ('rejected' in email_templates); the
--     SMS is an addition alongside it.
--   - Admin-side cancellation has never sent an email at all (it falls through
--     sharedUpdateStatus's generic branch). This migration does NOT change
--     that — it only makes an opt-in text possible. Starting to email on
--     cancel would be a behaviour change nobody asked for.
--
-- Both bodies carry a contact route in the text, because the alphanumeric
-- sender ID is one-way: a stallholder cannot reply to these.
--
-- ON CONFLICT DO NOTHING so re-running never clobbers wording an admin has
-- since edited in the SMS Template Manager.

INSERT INTO "public"."sms_templates" ("id", "body", "description") VALUES
  ('booking_rejected',
   'Hi {{owner_name}}, unfortunately we cannot offer you a stall at the Ella Street Festival this year. Replies are not monitored - email festival.stalls@ellastreet.co.uk if you have questions.',
   'Optional text sent when a booking is Rejected, alongside the rejection email. Placeholders: {{owner_name}}, {{business_name}}, {{booking_id}}.'),
  ('booking_cancelled',
   'Hi {{owner_name}}, your Ella Street Festival stall booking {{booking_id}} has been cancelled. Replies are not monitored - email festival.stalls@ellastreet.co.uk if this is unexpected.',
   'Optional text sent when a booking is Cancelled by an admin. Note the cancel path sends no email, so this may be the only notification. Placeholders: {{owner_name}}, {{business_name}}, {{booking_id}}.')
ON CONFLICT ("id") DO NOTHING;
