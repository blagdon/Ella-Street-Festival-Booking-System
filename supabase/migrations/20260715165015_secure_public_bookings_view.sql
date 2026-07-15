-- Security fix: remove anon's row-level SELECT access to "bookings" (the
-- "Public see confirmed" RLS policy) and the column-level grants that were
-- the only real backstop limiting what that policy exposed.
--
-- Investigation note: the PII columns named in the review (owner_name,
-- email, phone, address, admin_notes, rejection_reason, documents,
-- cancel_token) were never actually anon-selectable in practice -
-- pre-existing column-level GRANTs already restricted anon to just
-- id/business_name/category/stall_type/description/instance_prefix, and
-- Postgres enforces column privileges independently of RLS. But relying on
-- "RLS allows the row, column grants narrow the columns" as the only
-- safety net is fragile: a single future `GRANT SELECT ON bookings TO
-- anon` would silently re-expose every column, since the RLS policy alone
-- already permits full-row access to any Confirmed booking. This migration
-- removes that combination entirely and replaces it with a dedicated view,
-- mirroring the existing public_performer_info/public_schedule_info
-- pattern already used elsewhere in this schema: anon gets SELECT on a
-- narrow view only, never on the base bookings table, so a future
-- over-broad grant on bookings can no longer leak anything to anon.

-- "Allow public anon to read confirmed booking locations" (on
-- booking_locations) checks bookings.status via a cross-table subquery.
-- Once anon loses all RLS-permitted rows on bookings below, that subquery
-- would itself be filtered down to zero rows (it runs as anon), silently
-- breaking the public visitor map's location markers. A SECURITY DEFINER
-- helper - same pattern as the existing check_user_role() function -
-- keeps that check working without granting anon anything on bookings
-- directly (the function runs as its owner, bypassing RLS, same as any
-- other SECURITY DEFINER function in this schema).
CREATE OR REPLACE FUNCTION "public"."is_booking_confirmed"("p_booking_id" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM bookings
    WHERE id = p_booking_id AND status = 'Confirmed'
  );
END;
$$;

ALTER FUNCTION "public"."is_booking_confirmed"("p_booking_id" "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."is_booking_confirmed"("p_booking_id" "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."is_booking_confirmed"("p_booking_id" "text") FROM "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."is_booking_confirmed"("p_booking_id" "text") TO "anon", "authenticated";

DROP POLICY IF EXISTS "Allow public anon to read confirmed booking locations" ON "public"."booking_locations";
CREATE POLICY "Allow public anon to read confirmed booking locations" ON "public"."booking_locations" FOR SELECT TO "anon" USING ("public"."is_booking_confirmed"("booking_id"));


-- Remove anon's direct row/column access to bookings entirely.
DROP POLICY IF EXISTS "Public see confirmed" ON "public"."bookings";

REVOKE SELECT ("id") ON TABLE "public"."bookings" FROM "anon";
REVOKE SELECT ("business_name") ON TABLE "public"."bookings" FROM "anon";
REVOKE SELECT ("category") ON TABLE "public"."bookings" FROM "anon";
REVOKE SELECT ("stall_type") ON TABLE "public"."bookings" FROM "anon";
REVOKE SELECT ("description") ON TABLE "public"."bookings" FROM "anon";
REVOKE SELECT ("instance_prefix") ON TABLE "public"."bookings" FROM "anon";


-- Dedicated public view: only the columns needed for the public visitor
-- map, one row per (booking, assigned location) pair - a booking can have
-- multiple locations (see the Location Manager / multi-location feature),
-- so an inner join is correct here, not a left join: a confirmed booking
-- with no location assigned yet has nothing useful to show on the map.
CREATE OR REPLACE VIEW "public"."public_bookings_info" AS
 SELECT "b"."id",
    "b"."business_name",
    "b"."category",
    "b"."stall_type",
    "b"."description",
    "b"."instance_prefix",
    "bl"."location_id"
   FROM ("public"."bookings" "b"
     JOIN "public"."booking_locations" "bl" ON (("bl"."booking_id" = "b"."id")))
  WHERE ("b"."status" = 'Confirmed'::"text");

ALTER VIEW "public"."public_bookings_info" OWNER TO "postgres";

GRANT ALL ON TABLE "public"."public_bookings_info" TO "anon";
GRANT ALL ON TABLE "public"."public_bookings_info" TO "authenticated";
GRANT ALL ON TABLE "public"."public_bookings_info" TO "service_role";
