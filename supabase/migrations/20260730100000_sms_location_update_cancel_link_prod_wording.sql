-- Follow-up to 20260730090000: that migration's guarded UPDATE for
-- location_update skipped production, because an admin had already hand-
-- edited the row's wording (via the SMS Template Manager) to "...pitch is
-- now {{location_id}} Ella Street." before the migration ran — the guard
-- did its job and left the edit alone rather than clobbering it.
--
-- This migration adds {{cancel_link}} on top of that same hand-edited
-- wording, so production ends up with both the admin's phrasing AND the
-- cancel link the other two templates already carry. Guarded the same way:
-- only fires if the row still holds exactly that hand-edited text, so a
-- second, different edit since then is left alone too.

UPDATE "public"."sms_templates"
SET "body" = 'Hi {{owner_name}}, your Ella Street Festival pitch is now {{location_id}} Ella Street. Cancel: {{cancel_link}} festival.stalls@ellastreet.co.uk',
    "description" = 'Optional text sent from Location Manager (individual "Send Location" or bulk "Send Bulk Emails") alongside the location_update email. Placeholders: {{owner_name}}, {{business_name}}, {{booking_id}}, {{location_id}} (the assigned pitch(es), comma-separated), {{cancel_link}}.',
    "updated_at" = now()
WHERE "id" = 'location_update'
  AND "body" = 'Hi {{owner_name}}, your Ella Street Festival pitch is now {{location_id}} Ella Street. festival.stalls@ellastreet.co.uk';
