-- Last item from the original interrupted table-grant-narrowing brief:
-- anon held GRANT ALL (rwU - SELECT/currval, UPDATE/nextval+setval, USAGE)
-- on the three id sequences behind audit_logs, booking_locations, and
-- email_queue. No PostgREST surface exposes a sequence directly, so this
-- was never a live exploit path - pure hygiene, closing it because it can
-- be closed cleanly, not because anything was actively wrong.
--
-- Confirmed anon has zero legitimate reason to ever call nextval() on any
-- of the three: audit_logs and email_templates/hcc_checks were narrowed to
-- REVOKE ALL for anon in 20260718100000 (audit_logs specifically has no
-- INSERT/UPDATE/DELETE policy for anon at all); booking_locations was
-- narrowed to SELECT-only in the same migration; email_queue already had
-- zero anon access from earlier work (predates this session - see the
-- existing "email_queue is completely inaccessible to anon" test). None of
-- the three tables anon can INSERT into, so none of the three sequences
-- ever has nextval() invoked on anon's behalf through any legitimate path.
--
-- authenticated's grants on these same sequences are untouched - unlike
-- anon, authenticated genuinely does INSERT into audit_logs and email_queue
-- directly (confirmed in 20260718110000's own trace), so its sequence
-- usage is real and scoped separately if it's ever revisited.

REVOKE ALL ON SEQUENCE "public"."audit_logs_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."booking_locations_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."email_queue_id_seq" FROM "anon";
