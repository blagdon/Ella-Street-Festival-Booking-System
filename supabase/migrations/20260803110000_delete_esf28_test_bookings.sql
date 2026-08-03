-- Migration: 20260803110000_delete_esf28_test_bookings.sql
--
-- Deletes two admin-created test bookings found while auditing for real
-- fallout from the settings.booking_prefix drift fixed in
-- 20260803100000_fix_booking_prefix_drift.sql. Both rows are self-evidently
-- test clutter, not real trader applications (owner_name/email are the
-- admin's own; business_name is "New system test" / "Blaggers charity test
-- sec"), confirmed with the owner before deleting. booking_locations,
-- hcc_checks, and payments all cascade on bookings.id (ON DELETE CASCADE
-- in the baseline schema), so no separate cleanup is needed for those.
--
-- Narrow WHERE by exact id — a no-op anywhere these two ids don't exist
-- (e.g. the test project, which never had them).

DELETE FROM "public"."bookings"
WHERE "id" IN ('ESF28-NONFOOD-0001', 'ESF28-NONFOOD-0002');
