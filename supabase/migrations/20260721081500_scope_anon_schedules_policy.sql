-- Scope anon's SELECT access on `schedules` to match what `public_schedule_info`
-- already filters to, instead of leaving the base table wide open.
--
-- THE GAP: "Public row-level access for schedules" was `USING (true)` for
-- anon — every row, regardless of the linked performer's status. The
-- filtering to Scheduled/Paid performers has only ever lived in the
-- public_schedule_info view. Column grants already narrow what anon can
-- select on the table itself to id/performer_id/start_time/end_time/
-- duration_minutes/event_date (no location, no notes, no paid_status) — so
-- this was never as exposed as "every column of every row," but a caller
-- reading the table directly (rather than the view) could still see slot
-- times and performer IDs for Applied/Rejected/withdrawn performers, which
-- the view deliberately excludes.
--
-- SAFE TO APPLY WITH NO EXTERNAL COORDINATION, unlike the location_power
-- drop: verified against a live production dump immediately before writing
-- this that `schedules` currently holds ZERO rows. There is nothing for any
-- consumer, including the separate performer app
-- (ellafestperformersadmin.vercel.app, which this repo can't audit) to lose
-- access to today.
--
-- A PLAIN EXISTS SUBQUERY AGAINST performers DOES NOT WORK HERE, and this
-- was found empirically on the test project, not reasoned out correctly the
-- first time: anon has SELECT grants on individual performers columns
-- (id, name, description, performance_type, status, ...) but NOT on
-- deleted_at, which the filter needs to exclude soft-deleted performers.
-- Referencing deleted_at inside an inline EXISTS, evaluated as anon (the
-- actual querying role, regardless of it being inside a policy expression),
-- throws "permission denied for table performers" — not a silent
-- mis-filter, a hard error on every anon query against schedules at all,
-- which would have been a worse regression than the gap this migration
-- fixes. Confirmed by running the naive version against the test project
-- before writing this one.
--
-- Same shape of problem is_booking_confirmed() already solves for
-- booking_locations, for a related but distinct reason (there, anon has
-- ZERO row-level access to bookings at all, so an inline subquery would
-- silently return no rows rather than error). Same fix: a SECURITY DEFINER
-- helper, whose body runs as the function owner and is therefore not
-- subject to the calling role's column grants at all.

CREATE OR REPLACE FUNCTION "public"."is_performer_publicly_visible"("p_performer_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM performers
    WHERE id = p_performer_id
      AND status = ANY (ARRAY['Scheduled'::performer_status, 'Paid'::performer_status])
      AND deleted_at IS NULL
  );
END;
$$;

ALTER FUNCTION "public"."is_performer_publicly_visible"("p_performer_id" "uuid") OWNER TO "postgres";

-- Revoked by name, not just FROM PUBLIC: this schema's ALTER DEFAULT
-- PRIVILEGES history means a PUBLIC-only revoke has silently failed to
-- cover these roles before (see the Gotchas entry on that). anon needs no
-- direct EXECUTE grant to have the RLS policy below invoke this on its
-- behalf — permission is checked on the table the policy applies to, not
-- on the function that happens to run inside its USING clause.
REVOKE ALL ON FUNCTION "public"."is_performer_publicly_visible"("p_performer_id" "uuid") FROM "anon", "authenticated";
GRANT ALL ON FUNCTION "public"."is_performer_publicly_visible"("p_performer_id" "uuid") TO "service_role";

ALTER POLICY "Public row-level access for schedules" ON "public"."schedules"
  USING ("public"."is_performer_publicly_visible"("performer_id"));
