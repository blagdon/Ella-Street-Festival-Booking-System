-- Migration: 20260815210000_phase3_dev_location_retirement.sql
-- Multi-Event Architecture Phase 3 — DEV Location/Test-Data Retirement
--
-- Architectural decision: DEV locations (locations.dataset = 'DEV') were
-- test-only infrastructure — a full id-mirror of the real LIVE location
-- layout, used so an admin/QA tester could preview the whole booking
-- pipeline against realistic location data without touching real LIVE
-- inventory. They are not part of the product and are retired here.
--
-- This does NOT retire the booking-level DEV concept (booking_type='dev',
-- -DEV- instance prefixes, resolveStripeMode()'s DEV-forces-Stripe-test-mode
-- branch). That remains in place deliberately: it is currently the only
-- per-booking mechanism that guarantees a test booking can never charge a
-- real card, and retiring it requires a separately-designed replacement
-- mechanism, not something to fold into a locations cleanup. See
-- supabase/functions/_shared/stripe.ts — untouched by this migration.
--
-- Pre-deletion verification performed (read-only, against production, prior
-- to authoring this migration): every one of the 137 DEV location rows
-- shares its id with an existing LIVE row for the same org_id/event_id
-- (org_default/event_default in every case — no other organisation has any
-- locations yet). Every booking_locations row belonging to a non-DEV-type
-- booking that resolves against a DEV-dataset location also resolves
-- cleanly against the corresponding LIVE-dataset row for the *same*
-- org_id/event_id as the booking (52/52 checked, 0 missing, 0 mismatched) —
-- deleting the DEV rows leaves those existing assignments intact via their
-- surviving LIVE counterpart. No repair of booking data is performed or
-- required here.
--
-- Deletes, in dependency order:
--   1. Dependent records for the two explicitly-approved test bookings
--      (payments, audit_logs, booking_locations, hcc_checks — checked
--      empty or containing only these two bookings' own rows).
--   2. The two explicitly-approved test bookings themselves:
--        ESF26-FOOD-0041     (unpaid, Pending, no dependent records found)
--        ESF26-NONFOOD-0919  (Confirmed, one 'paid' payments row, two
--                             audit_logs rows — this is a DATABASE record
--                             deletion only; no Stripe API call is made and
--                             no Stripe object is refunded, cancelled, or
--                             otherwise modified by this migration)
--   3. All locations rows where dataset = 'DEV' (137 in production; 0 in
--      this test project today — this DELETE is a generic, idempotent
--      WHERE clause safe to run anywhere, not hardcoded to production row
--      counts).
--
-- Explicitly NOT deleted by this migration (found during investigation,
-- left for a separate decision — see the Phase 3 DEV-retirement report):
--   - email_queue rows whose subject/body happen to mention either
--     approved booking id (4 rows in production) — email_queue has no
--     booking_id column at all; these are historical send-logs, not a
--     referential-integrity dependent, and matching them would require an
--     imprecise text search.
--   - sms_queue rows, same reasoning (3 rows in production).
--   - storage.objects rows referencing either booking id (1 row in
--     production) — a Storage-layer file, not a database row a schema
--     migration naturally touches.
--
-- locations.dataset is NOT dropped as a column: schedules_location_fkey
-- FOREIGN KEY (location, dataset) REFERENCES locations(id, dataset) still
-- depends on it, and schedules/performers are explicitly out of scope for
-- this work. Going forward, dataset will only ever hold 'LIVE' for
-- application-managed rows (enforced in application code, not a CHECK
-- constraint — see the accompanying application changes).

-- ---------------------------------------------------------------------
-- 1. Dependent records for the two approved test bookings
-- ---------------------------------------------------------------------
DELETE FROM public.payments
WHERE booking_id IN ('ESF26-FOOD-0041', 'ESF26-NONFOOD-0919');

DELETE FROM public.audit_logs
WHERE target_id IN ('ESF26-FOOD-0041', 'ESF26-NONFOOD-0919');

DELETE FROM public.booking_locations
WHERE booking_id IN ('ESF26-FOOD-0041', 'ESF26-NONFOOD-0919');

DELETE FROM public.hcc_checks
WHERE booking_id IN ('ESF26-FOOD-0041', 'ESF26-NONFOOD-0919');

-- ---------------------------------------------------------------------
-- 2. The two approved test bookings themselves
-- ---------------------------------------------------------------------
DELETE FROM public.bookings
WHERE id IN ('ESF26-FOOD-0041', 'ESF26-NONFOOD-0919');

-- ---------------------------------------------------------------------
-- 3. All DEV-dataset locations. Generic and idempotent — matches whatever
--    exists wherever this migration runs, not a hardcoded row count.
-- ---------------------------------------------------------------------
DELETE FROM public.locations
WHERE dataset = 'DEV';
