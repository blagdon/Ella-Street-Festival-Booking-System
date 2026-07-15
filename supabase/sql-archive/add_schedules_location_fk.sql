-- ===================================================================
-- FIX: enforce referential integrity between schedules.location and
-- the canonical locations table
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- public.schedules (the performer-scheduling feature — not yet wired
-- up to any app code, but planned) stores `location` as free text with
-- no FK back to public.locations, so a typo in a timeline entry would
-- silently drift from the map data with no error.
--
-- locations is keyed on (id, dataset) rather than id alone — location
-- ids are only unique within a DEV/LIVE dataset, not globally — so a
-- plain FK to locations(id) isn't possible. schedules gets a `dataset`
-- column so the FK can be composite, matching the same DEV/LIVE
-- separation used elsewhere in the app (e.g. bookings.instance_prefix).
--
-- schedules currently has 0 rows, so dataset can be added NOT NULL
-- directly with no backfill needed.
-- ===================================================================

ALTER TABLE public.schedules ADD COLUMN dataset text NOT NULL;

ALTER TABLE public.schedules
  ADD CONSTRAINT schedules_location_fkey
  FOREIGN KEY (location, dataset) REFERENCES public.locations (id, dataset);

CREATE INDEX IF NOT EXISTS idx_schedules_location_dataset ON public.schedules (location, dataset);

-- ===================================================================
-- VERIFY:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.schedules'::regclass AND contype = 'f';
--   -- Should show schedules_location_fkey referencing locations(id, dataset).
-- ===================================================================
