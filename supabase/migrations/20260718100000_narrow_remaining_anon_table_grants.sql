-- Continuation of 20260717100000 (settings) and 20260718090000 (payments):
-- narrows every remaining table/view where anon still held GRANT ALL down to
-- what anon's own RLS policies (or, for views, nothing at all) actually
-- allow through. Same rationale each time: RLS being the only thing between
-- anon and a table is a single point of failure — a bad policy edit or an
-- accidental DISABLE ROW LEVEL SECURITY should not instantly hand anon
-- INSERT/UPDATE/DELETE. The table grant becomes a second, independent
-- layer.
--
-- Traced before touching anything, same rigor as payments:
--   - Every CREATE TRIGGER in the schema (5 total, all in the baseline
--     migration) was checked: none write into any of the six tables below,
--     and the one trigger that IS on a table here (booking_locations'
--     conflict-check trigger) only fires on INSERT/UPDATE, both already
--     blocked from anon by RLS regardless of the table grant.
--   - Every .from('<table>') call site across js/ and supabase/functions/
--     was traced to its actual reachability, not just which file it lives
--     in — js/api.js is NOT purely admin-only as previously assumed:
--     js/map.js (used by the public visitor_map.html) imports its
--     fetchMapData() directly, which is why locations and
--     public_bookings_info need anon SELECT. Every other call site touching
--     the tables narrowed to zero below lives in a function only ever
--     invoked from admin-authenticated pages (confirmed by tracing the
--     containing function, not just the importing file).
--
--   anon: REVOKE ALL, no replacement grant (zero access, same as payments):
--     - audit_logs: only policy is "Admin view audit" (admin-only SELECT).
--       No INSERT/UPDATE policy exists for any role but authenticated.
--     - email_templates: only policy is "Admin manage email_templates"
--       (authenticated, admin-gated). getEmailFromTemplate() in
--       js/shared.js is the only client reader; shared.js is never
--       imported by any public-facing page, and js/api.js merely loading
--       shared.js as a module dependency (for fetchMapData's page, above)
--       does not call it.
--     - hcc_checks: only policy is "Admins manage hcc_checks" (admin-only).
--       The INSERT in js/api.js lives inside the booking-status-update
--       function, only reachable from admin pages.
--
--   anon: REVOKE ALL, GRANT SELECT (RLS still filters rows/columns):
--     - booking_locations: "Allow public anon to read confirmed booking
--       locations" is SELECT-only, filtered to is_booking_confirmed().
--     - location_power: "Public view power" is SELECT-only (unfiltered).
--       No client call site anywhere in this repo currently reads it, but
--       SELECT matches what its own RLS policy already allows, so this is
--       narrowing, not removing functionality.
--     - locations: "Public view locations" is SELECT-only, filtered to
--       dataset = 'LIVE'. Actively read by fetchMapData() (js/api.js) via
--       the public visitor map.
--
--   anon: REVOKE ALL, GRANT SELECT (views only — "views get SELECT at
--   most"; a view runs its internal query as the view owner regardless of
--   the caller's own grant, so this only blocks anon ever attempting a
--   write against the view itself, and none of the three has an INSTEAD OF
--   trigger that would make a write meaningful):
--     - public_bookings_info: read by fetchMapData() for the visitor map.
--     - public_performer_info, public_schedule_info: no call site in this
--       repo (consumed by the separate performers-admin app per
--       HANDOVER.md), but SELECT is the only privilege any legitimate
--       reporting-view consumer would ever need.
--
-- Pure hygiene, zero functional risk: bookings/performers/schedules were
-- already narrowed from table-level ALL down to column-level grants (see
-- their own migrations) for anon's real access, but a vestigial table-level
-- TRIGGER privilege was left behind on all three. TRIGGER only gates
-- CREATE TRIGGER ... ON <table> DDL — it has no bearing on whether existing
-- triggers fire for a role's own DML — so revoking it changes nothing
-- anon can actually do. Column-level grants on these three tables are left
-- completely untouched, per this project's standing rule that they are
-- deliberate and not to be broadened or collapsed into table grants.
--
-- authenticated/service_role grants are untouched everywhere in this
-- migration; scoped to anon only.

REVOKE ALL ON TABLE "public"."audit_logs" FROM "anon";
REVOKE ALL ON TABLE "public"."email_templates" FROM "anon";
REVOKE ALL ON TABLE "public"."hcc_checks" FROM "anon";

REVOKE ALL ON TABLE "public"."booking_locations" FROM "anon";
GRANT SELECT ON TABLE "public"."booking_locations" TO "anon";

REVOKE ALL ON TABLE "public"."location_power" FROM "anon";
GRANT SELECT ON TABLE "public"."location_power" TO "anon";

REVOKE ALL ON TABLE "public"."locations" FROM "anon";
GRANT SELECT ON TABLE "public"."locations" TO "anon";

REVOKE ALL ON TABLE "public"."public_bookings_info" FROM "anon";
GRANT SELECT ON TABLE "public"."public_bookings_info" TO "anon";

REVOKE ALL ON TABLE "public"."public_performer_info" FROM "anon";
GRANT SELECT ON TABLE "public"."public_performer_info" TO "anon";

REVOKE ALL ON TABLE "public"."public_schedule_info" FROM "anon";
GRANT SELECT ON TABLE "public"."public_schedule_info" TO "anon";

REVOKE TRIGGER ON TABLE "public"."bookings" FROM "anon";
REVOKE TRIGGER ON TABLE "public"."performers" FROM "anon";
REVOKE TRIGGER ON TABLE "public"."schedules" FROM "anon";
