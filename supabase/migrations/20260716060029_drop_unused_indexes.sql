-- Drops two indexes flagged during a schema-wide unused-index audit.
-- Verified via static analysis (not runtime pg_stat_user_indexes, but both
-- are unambiguous regardless: no query anywhere touches the indexed
-- column, so the index cannot possibly be used by anything):
--
-- idx_bookings_email - no code anywhere (admin JS or Edge Functions)
-- filters bookings by email. There's no duplicate-detection feature today.
--
-- idx_audit_logs_target_id - target_id is written on every audit_logs
-- insert but never read back in a WHERE filter anywhere - there is no
-- admin page anywhere in this repo that browses audit_logs at all (see
-- the audit_logs dead-column cleanup from earlier the same day).
DROP INDEX IF EXISTS "public"."idx_bookings_email";
DROP INDEX IF EXISTS "public"."idx_audit_logs_target_id";
