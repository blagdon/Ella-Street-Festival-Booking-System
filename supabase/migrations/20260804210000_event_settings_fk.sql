-- Migration: 20260804210000_event_settings_fk.sql
-- RC operational certification, Finding 4 — event_settings.event_id had no
-- foreign key to events.id, so a write against an event that doesn't exist
-- (or no longer exists) succeeded silently instead of failing. This is
-- exactly what happened to the test organisation used in the certification:
-- its admin UI cached a fully-formed event client-side that had never
-- actually been persisted (or had been rolled back — see the
-- provision-organisation catch-block scoping fix, the likely root cause),
-- and Event Configuration let the org "successfully" save 3 settings
-- against that phantom event_id with no error at any point.
--
-- Existing orphaned rows must be cleared first — adding the constraint
-- against violating data fails outright. ON DELETE CASCADE so that
-- deleting an event (including provisioning's own rollback path) cleans up
-- its overrides automatically instead of leaving new orphans or blocking
-- the delete.

DELETE FROM "public"."event_settings"
WHERE "event_id" NOT IN (SELECT "id" FROM "public"."events");

ALTER TABLE "public"."event_settings"
    ADD CONSTRAINT "event_settings_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "public"."events"("id")
    ON DELETE CASCADE;
