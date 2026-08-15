-- Migration: 20260815100000_phase3_wp1_location_ownership_hardening.sql
-- Multi-Event Architecture Phase 3 — WP1: Location Ownership / RPC Hardening
--
-- Problem (Phase 3 architectural review): rpc_set_booking_locations()
-- authorises the caller against the booking's own org_id, but never
-- verifies that the supplied p_location_ids actually belong to that
-- booking's organisation/event. booking_locations.location_id has no FK
-- to locations (not viable — locations' PK is the composite (id, dataset),
-- so id alone isn't globally unique; a plain FK isn't expressible). Any
-- authenticated admin/steward of ANY org can attach their own booking to
-- another org's real, guessable location id (e.g. a common seed id like
-- 'P1', confirmed colliding across orgs in practice per
-- js/page-admin-locations.js's own comments).
--
-- Fix follows the same "re-derive and verify ownership server-side" pattern
-- already established by rpc_get_next_misc_id (20260814100000): fetch the
-- referencing resource's own org_id/event_id, then verify every referenced
-- resource actually belongs to it before acting.
--
-- Invariant enforced, unconditionally, for every supplied location:
--     location.org_id   = booking.org_id
--     AND location.event_id = booking.event_id
--     AND location.dataset  = 'LIVE'
--
-- No DEV exception. An earlier draft of this migration relaxed the dataset
-- check for DEV bookings, to preserve a deliberately-tested DEV/LIVE
-- location-reuse behaviour. That behaviour, and the DEV location dataset
-- itself, has since been retired as test-only infrastructure (see
-- 20260815210000_phase3_dev_location_retirement.sql) — every product
-- location now lives in the LIVE dataset only, so the relaxation no longer
-- has anything to relax for and has been removed. The booking-level DEV
-- concept (booking_type='dev', -DEV- instance prefixes, resolveStripeMode())
-- is explicitly NOT touched here — that remains in place as the sole
-- per-booking Stripe test-mode guarantee, pending a separate, dedicated
-- replacement design.
--
-- Also hardens booking_locations_check_conflict with the identical
-- existence/ownership check, as defense-in-depth directly at the table
-- level (today the RPC is the sole write path — direct authenticated
-- table writes are rejected — so this is belt-and-braces, not required to
-- close the exploitable path, but keeps the invariant enforced consistently
-- wherever a row could ever be written, not only by the one function that
-- currently happens to be the only writer).
--
-- No schema change, no FK, no data migration — this only gates future
-- writes. See the Phase 3 spec for the required read-only production audit
-- of any pre-existing mismatched booking_locations rows (not part of this
-- migration; existing rows are not touched or repaired here).

-- ---------------------------------------------------------------------
-- rpc_set_booking_locations
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."rpc_set_booking_locations"("p_booking_id" text, "p_location_ids" text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_booking_org_id    text;
    v_booking_event_id  text;
    v_filtered_ids      text[];
    v_distinct_supplied int;
    v_valid_count       int;
BEGIN
    SELECT org_id, event_id
      INTO v_booking_org_id, v_booking_event_id
    FROM bookings WHERE id = p_booking_id;

    IF NOT is_authorised_for_org(v_booking_org_id, ARRAY['admin', 'steward']) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    SELECT array_agg(loc) INTO v_filtered_ids
    FROM unnest(p_location_ids) AS loc
    WHERE loc IS NOT NULL AND trim(loc) <> '';

    -- Every supplied location must genuinely belong to this booking's own
    -- organisation and event, and be a real LIVE-dataset product location —
    -- never trust a client-supplied location id on its own, even from an
    -- otherwise-authorised admin, since nothing else here re-derives
    -- ownership from p_location_ids. No DEV exception (DEV locations have
    -- been retired).
    IF v_filtered_ids IS NOT NULL THEN
        SELECT count(DISTINCT loc) INTO v_distinct_supplied FROM unnest(v_filtered_ids) AS loc;

        SELECT count(*) INTO v_valid_count
        FROM locations
        WHERE id = ANY(v_filtered_ids)
          AND org_id = v_booking_org_id
          AND event_id = v_booking_event_id
          AND dataset = 'LIVE';

        IF v_valid_count <> v_distinct_supplied THEN
            RAISE EXCEPTION 'One or more locations do not belong to this booking''s organisation/event, or do not exist.';
        END IF;
    END IF;

    LOCK TABLE booking_locations IN SHARE ROW EXCLUSIVE MODE;

    DELETE FROM booking_locations WHERE booking_id = p_booking_id;

    INSERT INTO booking_locations (booking_id, location_id)
    SELECT p_booking_id, loc
    FROM unnest(v_filtered_ids) AS loc;
END;
$$;

-- ---------------------------------------------------------------------
-- booking_locations_check_conflict — adds the identical ownership check
-- as defense-in-depth, ahead of the pre-existing conflict-detection logic
-- (unchanged below this point). Conflict detection itself stays scoped by
-- event_id (added 20260801101, before this Phase 3 work) — that part
-- never depended on dataset for its own correctness and is untouched.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."booking_locations_check_conflict"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_new_org_id   text;
    v_new_event_id text;
    v_conflict_id  text;
BEGIN
    SELECT org_id, event_id
      INTO v_new_org_id, v_new_event_id
    FROM bookings WHERE id = NEW.booking_id;

    IF NOT EXISTS (
        SELECT 1 FROM locations
        WHERE id = NEW.location_id
          AND org_id = v_new_org_id
          AND event_id = v_new_event_id
          AND dataset = 'LIVE'
    ) THEN
        RAISE EXCEPTION 'Location % does not belong to this booking''s organisation/event.', NEW.location_id;
    END IF;

    SELECT bl.booking_id INTO v_conflict_id
    FROM booking_locations bl
    JOIN bookings b2 ON b2.id = bl.booking_id
    WHERE bl.location_id = NEW.location_id
      AND bl.booking_id <> NEW.booking_id
      AND b2.status = 'Confirmed'
      AND b2.event_id = v_new_event_id
    LIMIT 1;

    IF v_conflict_id IS NOT NULL THEN
        RAISE EXCEPTION 'Location % is already assigned to booking %', NEW.location_id, v_conflict_id
            USING ERRCODE = 'unique_violation';
    END IF;

    RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."booking_locations_check_conflict"() OWNER TO postgres;
