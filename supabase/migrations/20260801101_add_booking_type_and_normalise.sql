-- Migration: 20260801101_add_booking_type_and_normalise.sql
-- Phase 2 — Tenant Awareness & Normalisation: Step 1
--
-- Adds explicit booking_type column to bookings table and backfills from
-- instance_prefix. Disentangles the instance_prefix string (e.g. 'ESF26-FOOD-')
-- into explicit event_id + booking_type ('food', 'general', 'misc', 'dev').
--
-- Backwards compatibility guarantee:
--   instance_prefix remains on bookings as a column and continues to be set/read.
--   Existing booking ID formats (ESF26-FOOD-0042) and public booking forms
--   remain 100% unchanged.

-- Step 1: Add booking_type column with check constraint
ALTER TABLE "public"."bookings"
    ADD COLUMN IF NOT EXISTS "booking_type" text;

-- Step 2: Backfill booking_type from instance_prefix
UPDATE "public"."bookings"
SET "booking_type" = CASE
    WHEN instance_prefix LIKE '%-FOOD-%'    THEN 'food'
    WHEN instance_prefix LIKE '%-NONFOOD-%' THEN 'general'
    WHEN instance_prefix LIKE '%-MISC-%'    THEN 'misc'
    WHEN instance_prefix LIKE '%-DEV-%'     THEN 'dev'
    ELSE 'dev'
END
WHERE "booking_type" IS NULL;

-- Step 3: Add DEFAULT and NOT NULL constraint after backfill
ALTER TABLE "public"."bookings"
    ALTER COLUMN "booking_type" SET DEFAULT 'dev',
    ALTER COLUMN "booking_type" SET NOT NULL,
    ADD CONSTRAINT "bookings_booking_type_check"
        CHECK (booking_type IN ('food', 'general', 'misc', 'dev'));

COMMENT ON COLUMN "public"."bookings"."booking_type" IS
    'Normalised booking category: food, general, misc, or dev. '
    'Extracted from instance_prefix in Phase 2 for clean data model queries. '
    'instance_prefix remains populated for backwards compatibility.';

CREATE INDEX IF NOT EXISTS "idx_bookings_booking_type" ON "public"."bookings" ("booking_type");
CREATE INDEX IF NOT EXISTS "idx_bookings_event_booking_type" ON "public"."bookings" ("event_id", "booking_type");

-- Step 4: Update booking_locations_check_conflict trigger function
-- Replaces the hardcoded LIKE '%-DEV-' check with a clean event_id + dataset comparison
CREATE OR REPLACE FUNCTION "public"."booking_locations_check_conflict"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_new_event_id text;
    v_new_dataset  text;
    v_conflict_id  text;
BEGIN
    SELECT event_id, CASE WHEN instance_prefix LIKE '%-DEV-' THEN 'DEV' ELSE 'LIVE' END
      INTO v_new_event_id, v_new_dataset
    FROM bookings WHERE id = NEW.booking_id;

    SELECT bl.booking_id INTO v_conflict_id
    FROM booking_locations bl
    JOIN bookings b2 ON b2.id = bl.booking_id
    WHERE bl.location_id = NEW.location_id
      AND bl.booking_id <> NEW.booking_id
      AND b2.status = 'Confirmed'
      AND b2.event_id = v_new_event_id
      AND (CASE WHEN b2.instance_prefix LIKE '%-DEV-' THEN 'DEV' ELSE 'LIVE' END) = v_new_dataset
    LIMIT 1;

    IF v_conflict_id IS NOT NULL THEN
        RAISE EXCEPTION 'Location % is already assigned to booking %', NEW.location_id, v_conflict_id
            USING ERRCODE = 'unique_violation';
    END IF;

    RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."booking_locations_check_conflict"() OWNER TO postgres;
