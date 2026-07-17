-- public_schedule_info had no WHERE clause at all - unlike its sibling
-- public_performer_info (status IN ('Scheduled','Paid') AND deleted_at IS
-- NULL), it exposed every schedules row unconditionally. anon has a live
-- GRANT on this view, so this wasn't theoretical: a schedule slot belonging
-- to an Applied/Rejected or soft-deleted performer (deleted_at is owned by
-- the separate ellafestperformersadmin.vercel.app app, same as the
-- performers-table gap fixed in 20260716105038) stayed publicly visible.
-- Low sensitivity (only start/end time, location, duration, event_date,
-- performer_id - no PII), but inconsistent with the sibling view's rule and
-- worth closing anyway.
--
-- schedules.performer_id has a real FK to performers.id (ON DELETE CASCADE),
-- so an inner join can never drop a legitimately-orphaned row - same
-- reasoning as public_bookings_info's inner join on booking_locations.
CREATE OR REPLACE VIEW "public"."public_schedule_info" AS
 SELECT s."id",
    s."performer_id",
    s."location",
    s."start_time",
    s."end_time",
    s."duration_minutes",
    s."event_date"
   FROM "public"."schedules" s
   JOIN "public"."performers" p ON p."id" = s."performer_id"
  WHERE (("p"."status" = ANY (ARRAY['Scheduled'::"public"."performer_status", 'Paid'::"public"."performer_status"])) AND ("p"."deleted_at" IS NULL));
