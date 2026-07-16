-- Drops three dead columns on audit_logs, flagged during a schema-wide dead
-- column audit and verified before acting (same discipline as the
-- location_id cleanup): auditLog() (js/api.js) - the only function that
-- ever writes to this table - only sets action, target_id, user_email,
-- details, and instance. user_name, action_type, and booking_id are never
-- written by it, and there is no admin page anywhere in this repo that
-- reads audit_logs back out either, so nothing else could be populating or
-- displaying them. action_type/booking_id were superseded by the
-- generic action/target_id columns (target_id serves as the booking id
-- for booking-related actions, and for other target types too); user_name
-- was apparently never wired up alongside user_email. No indexes or
-- constraints reference any of the three.
ALTER TABLE "public"."audit_logs"
    DROP COLUMN IF EXISTS "user_name",
    DROP COLUMN IF EXISTS "action_type",
    DROP COLUMN IF EXISTS "booking_id";
