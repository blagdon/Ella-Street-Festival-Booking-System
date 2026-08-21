-- Phase 2C — composite bookings/locations -> events FK hardening.
--
-- The Phase 2C read-only design pass established: bookings.org_id and
-- locations.org_id have never had any FK at all, and the existing single-
-- column bookings_event_id_fkey / locations_event_id_fkey only guarantee the
-- referenced event exists, not that it belongs to the same organisation as
-- the booking/location row itself. Today that relationship is maintained
-- entirely by application discipline (every insert path already supplies a
-- consistent org_id/event_id pair together — confirmed by exhaustive
-- write-path audit, and by the TEST/production data-integrity audits, both
-- clean after the Phase 2C prerequisite cleanup removed the one known
-- orphaned test-fixture row). This migration makes that relationship
-- DB-enforced instead of convention-only.
--
-- events has no existing UNIQUE(org_id, id) — only PRIMARY KEY(id) alone.
-- Postgres composite foreign keys require a unique constraint on the
-- referenced column tuple, so step 1 below adds one. Since events.id is
-- already globally unique via its own PK, UNIQUE(org_id, id) is a
-- redundant-but-legal superset and is added with zero risk of a duplicate
-- (confirmed: zero duplicate (org_id, id) pairs on TEST before this runs).
--
-- ON DELETE RESTRICT is preserved unchanged from both existing single-column
-- FKs being replaced — no change to delete semantics, only to what
-- (org_id, event_id) combination is accepted on insert/update.
--
-- Deliberately NOT touched by this migration: RLS policies, grants,
-- SECURITY DEFINER functions, booking_locations (including its own missing
-- FK to locations — a separate, pre-existing gap noted in the Phase 2C
-- design report, out of scope here), event_settings, settings, provisioning,
-- event activation, platform-admin behaviour, performers/schedules/
-- user_roles, ESF_INSTANCE, HCC, DEV/Stripe mechanisms, or any application/
-- Edge Function code.
--
-- TEST project only at authoring time (qeplpcnrkgpaawfyliap). Not yet
-- applied to production.

-- ---------------------------------------------------------------------
-- 1. Required unique constraint backing the composite FKs below.
-- ---------------------------------------------------------------------
ALTER TABLE "public"."events"
  ADD CONSTRAINT "events_org_id_id_unique" UNIQUE ("org_id", "id");

-- ---------------------------------------------------------------------
-- 2. bookings: replace the single-column event_id FK with a composite FK
--    that also pins org_id to the event's own organisation.
-- ---------------------------------------------------------------------
ALTER TABLE "public"."bookings"
  DROP CONSTRAINT "bookings_event_id_fkey";

ALTER TABLE "public"."bookings"
  ADD CONSTRAINT "bookings_org_event_fkey"
  FOREIGN KEY ("org_id", "event_id")
  REFERENCES "public"."events" ("org_id", "id")
  ON DELETE RESTRICT;

-- ---------------------------------------------------------------------
-- 3. locations: same replacement, same reasoning.
-- ---------------------------------------------------------------------
ALTER TABLE "public"."locations"
  DROP CONSTRAINT "locations_event_id_fkey";

ALTER TABLE "public"."locations"
  ADD CONSTRAINT "locations_org_event_fkey"
  FOREIGN KEY ("org_id", "event_id")
  REFERENCES "public"."events" ("org_id", "id")
  ON DELETE RESTRICT;
