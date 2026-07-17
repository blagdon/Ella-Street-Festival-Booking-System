-- rpc_get_next_misc_id: atomically generates the next ESF26-MISC-XXXX ID.
--
-- generateMiscEntryId() in js/api.js used a client-side read-max-insert pattern
-- that is vulnerable to a race condition: two admins adding a Misc booking
-- concurrently could both read the same max value, produce the same ID, and
-- have one insert fail with a PK violation (or in a worst-case without a PK
-- constraint, silently produce a duplicate). This is the identical class of bug
-- that get_next_booking_id() suffered and was fixed with LOCK TABLE in the
-- baseline schema. This migration applies the same fix.
--
-- The function is SECURITY DEFINER so it can take the lock and read the bookings
-- table on behalf of the calling admin. Access is restricted to authenticated
-- users with the admin role (checked via user_roles), so anon/unauthenticated
-- callers are explicitly rejected. No anon/authenticated EXECUTE grant is issued
-- (following the ALTER DEFAULT PRIVILEGES revocation in
-- 20260717080000_revoke_vestigial_anon_function_grants.sql).

CREATE OR REPLACE FUNCTION "public"."rpc_get_next_misc_id"()
RETURNS "text"
LANGUAGE "plpgsql"
SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
DECLARE
  v_role  TEXT;
  v_prefix TEXT;
  v_max_num INT;
  v_new_id  TEXT;
BEGIN
  -- Restrict to admin role only (Misc bookings are admin-only).
  SELECT role INTO v_role
  FROM user_roles
  WHERE id = auth.uid();

  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Not authorized: admin role required';
  END IF;

  -- Lock the bookings table for the duration of this transaction so that
  -- two concurrent calls cannot both read the same max value and generate
  -- the same ID. Mirrors get_next_booking_id()'s locking strategy exactly.
  LOCK TABLE bookings IN SHARE ROW EXCLUSIVE MODE;

  -- Determine the MISC prefix dynamically from the settings table so this
  -- function stays correct if the booking_prefix setting is ever changed.
  SELECT COALESCE(value, 'ESF26') || '-MISC-'
  INTO v_prefix
  FROM settings
  WHERE key = 'booking_prefix'
  LIMIT 1;

  -- Fall back to the hard-coded default if the setting is absent.
  IF v_prefix IS NULL THEN
    v_prefix := 'ESF26-MISC-';
  END IF;

  SELECT COALESCE(
    MAX(CAST(SPLIT_PART(id, v_prefix, 2) AS INT)),
    0
  )
  INTO v_max_num
  FROM bookings
  WHERE id LIKE v_prefix || '%'
    AND id ~ ('^' || v_prefix || '\d+$');

  v_new_id := v_prefix || LPAD((v_max_num + 1)::TEXT, 4, '0');

  RETURN v_new_id;
END;
$$;

-- Ownership: keep consistent with all other functions in this schema.
ALTER FUNCTION "public"."rpc_get_next_misc_id"() OWNER TO "postgres";

-- Explicit grant to authenticated only (admin role enforced inside the function).
-- No anon grant — Misc booking creation is an admin-only action.
GRANT EXECUTE ON FUNCTION "public"."rpc_get_next_misc_id"() TO "authenticated";
