-- booking_locations_check_conflict() only ever ran a plain SELECT before
-- RAISE EXCEPTION - no SELECT ... FOR UPDATE, no table lock. That's a
-- classic check-then-act race: confirmed empirically by forcing two
-- concurrent rpc_set_booking_locations() calls (for two different
-- Confirmed bookings, same pitch) to overlap - both passed the conflict
-- check and both committed, leaving two bookings genuinely double-booked
-- on the same location. This mirrors the exact same class of bug already
-- fixed once in this schema: get_next_booking_id() (see baseline schema,
-- "Lock the table to prevent concurrent calls getting the same number").
--
-- Fix follows that same precedent: lock booking_locations for the
-- duration of the assignment, in the one function that's the sole write
-- path for this table from application code (js/api.js and
-- js/page-steward.js both only ever call this RPC - nothing in the app
-- writes to booking_locations directly). SHARE ROW EXCLUSIVE MODE
-- conflicts with itself, so a second concurrent call blocks until the
-- first fully commits or rolls back, at which point its own conflict
-- check will correctly see the first call's now-committed row.
CREATE OR REPLACE FUNCTION "public"."rpc_set_booking_locations"("p_booking_id" "text", "p_location_ids" "text"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM user_roles
        WHERE user_roles.id = auth.uid() AND user_roles.role IN ('admin', 'steward')
    ) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    LOCK TABLE booking_locations IN SHARE ROW EXCLUSIVE MODE;

    DELETE FROM booking_locations WHERE booking_id = p_booking_id;

    INSERT INTO booking_locations (booking_id, location_id)
    SELECT p_booking_id, loc
    FROM unnest(p_location_ids) AS loc
    WHERE loc IS NOT NULL AND trim(loc) <> '';
END;
$$;
