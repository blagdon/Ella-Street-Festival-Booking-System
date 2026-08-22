-- Phase 2E — booking_locations -> locations FK hardening.
--
-- booking_locations.location_id has never had any FK at all — only
-- booking_locations_booking_id_fkey (-> bookings, CASCADE) exists. A
-- location_id here was never verified to reference a real locations row,
-- let alone the right one; the only protection is the
-- booking_locations_check_conflict() trigger, which re-derives the
-- booking's own org_id/event_id and checks the target location matches
-- (org_id, event_id, dataset='LIVE') before allowing the insert/update.
-- rpc_set_booking_locations (the sole write path) repeats the same check
-- before ever reaching the trigger. Both remain unchanged by this
-- migration and remain the ONLY enforcement for the org/event ownership
-- match — a plain FK is a simple existence check and cannot express
-- "belongs to the same org/event as some other table's row" the way a
-- trigger can. This migration closes a different, narrower gap: nothing
-- previously stopped a location_id from referencing a location that
-- doesn't exist AT ALL (of any org/event), which the trigger/RPC checks
-- happen to also catch today (their own EXISTS/count checks fail closed
-- on a nonexistent id), but only for the two write paths that call them —
-- a direct INSERT bypassing both (e.g. a future service-role script) had
-- no backstop whatsoever until now.
--
-- locations' PK is (id, dataset) — deliberately not being changed here or
-- ever without a separate, externally-coordinated decision (see the
-- Phase 2E discovery report: locations' PK also backs schedules_location_
-- fkey, a table owned by a separate application this repo cannot audit).
-- A composite FK from booking_locations therefore must reference exactly
-- that (id, dataset) shape, which means booking_locations needs its own
-- dataset column first — the same precedent already used for
-- schedules.location/schedules.dataset before schedules_location_fkey
-- could be added.
--
-- dataset is added NOT NULL DEFAULT 'LIVE': rpc_set_booking_locations's
-- own INSERT (INSERT INTO booking_locations (booking_id, location_id)
-- ...) never specifies dataset today and does not need to change — every
-- existing/future row from that RPC picks up the default unchanged.
-- CHECK (dataset = 'LIVE') encodes, at the schema level, the same
-- LIVE-only invariant the trigger and RPC already enforce independently
-- (DEV was retired as a product concept in Phase 3 - 20260815210000 -
-- though the locations.dataset column itself still carries non-LIVE rows
-- for schedules_location_fkey's sake; booking_locations must never
-- reference one of those).
--
-- ON DELETE CASCADE (not RESTRICT): js/page-admin-locations.js's own
-- delete confirmation dialog already tells the admin "Any booking
-- currently assigned to it will be unassigned" — today that promise is
-- FALSE (no FK exists, so the booking_locations row is silently orphaned,
-- not removed). CASCADE makes that existing, user-facing promise actually
-- true for the first time, rather than introducing a new hard failure
-- (RESTRICT) the admin UI never expected and doesn't handle. This is a
-- deliberate departure from the RESTRICT convention used for genuinely
-- operational records (payments, queues) elsewhere in this project —
-- a location assignment is closer to current-state-tracking-its-parent
-- than an immutable operational record.
--
-- Deliberately NOT touched by this migration: the locations PK itself,
-- schedules/schedules_location_fkey, performers, event_settings,
-- audit_logs.event_id, RLS policies, grants, or any application/Edge
-- Function code (rpc_set_booking_locations's INSERT needs no change, per
-- above).
--
-- TEST project only at authoring time (qeplpcnrkgpaawfyliap). Not yet
-- applied to production.

ALTER TABLE "public"."booking_locations"
  ADD COLUMN "dataset" text NOT NULL DEFAULT 'LIVE';

ALTER TABLE "public"."booking_locations"
  ADD CONSTRAINT "booking_locations_dataset_check" CHECK ("dataset" = 'LIVE');

ALTER TABLE "public"."booking_locations"
  ADD CONSTRAINT "booking_locations_location_id_fkey"
  FOREIGN KEY ("location_id", "dataset")
  REFERENCES "public"."locations" ("id", "dataset")
  ON DELETE CASCADE;
