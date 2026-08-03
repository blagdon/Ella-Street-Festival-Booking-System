-- Migration: 20260803100000_fix_booking_prefix_drift.sql
--
-- Data fix: settings.booking_prefix for org_default had drifted to 'ESF28'
-- (and festival_display_name to 'Ella Street Festival 28' alongside it),
-- while the org's actual event (event_default) uses 'ESF26' for real
-- booking IDs. js/utils.js's validateBookingId() read this settings value
-- directly rather than the active event's own booking_prefix, so once the
-- two diverged it rejected every genuinely valid ESF26-... booking ID
-- (reported live as "Invalid booking ID format" when moving a booking to
-- Payment Requested/Confirmed).
--
-- Fixed at the code level separately (validateBookingId now resolves the
-- prefix from the active event, matching how CONFIG.INSTANCE_MAP already
-- does), but the underlying settings data is also wrong and read directly
-- by the public booking forms to build new booking IDs — left uncorrected,
-- any new public submission would be created as ESF28-... and never match
-- the ESF26 event it actually belongs to, silently disappearing from the
-- Kanban board exactly like the original report.
--
-- Narrow, exact-current-value WHERE clauses: a no-op if either value has
-- already been corrected another way (e.g. by hand via settings.html)
-- before this runs.

UPDATE "public"."settings"
SET "value" = 'ESF26', "updated_at" = now(), "updated_by" = 'incident_fix_2026-08-03'
WHERE "org_id" = 'org_default' AND "key" = 'booking_prefix' AND "value" = 'ESF28';

UPDATE "public"."settings"
SET "value" = 'Ella Street Festival 2026', "updated_at" = now(), "updated_by" = 'incident_fix_2026-08-03'
WHERE "org_id" = 'org_default' AND "key" = 'festival_display_name' AND "value" = 'Ella Street Festival 28';
