-- Narrows `authenticated`'s table grants for the tables/views this repo's
-- own admin app actually uses, following the same defense-in-depth
-- rationale as the anon narrowing (20260717100000, 20260718090000,
-- 20260718100000): RLS being the only thing standing between authenticated
-- and, say, DELETE on payments is a single point of failure. Unlike anon
-- (which mostly needed zero/SELECT), authenticated genuinely needs broad
-- CRUD for the admin app to function - this migration removes only the
-- privileges no RLS policy AND no code path ever actually uses.
--
-- Methodology: for every table, checked (a) the exact FOR-clause command
-- each authenticated-reachable RLS policy allows, and (b) every real
-- .insert()/.update()/.delete()/.upsert() call site across js/ AND every
-- Edge Function (all nine confirmed to use SERVICE_ROLE_KEY exclusively for
-- DB writes, so none of them depend on the authenticated role's own table
-- grants at all - that's a separate, already-maximal privilege boundary).
-- TRUNCATE/REFERENCES/TRIGGER are dropped everywhere below regardless -
-- none are reachable via PostgREST and no RLS policy ever implies them.
--
--   audit_logs: SELECT, INSERT only. RLS itself only allows those two for
--     authenticated ("Admin view audit" is SELECT, "Allow authenticated
--     users to insert audit logs" is INSERT, WITH CHECK true - no
--     UPDATE/DELETE policy exists for authenticated at all). Matches
--     js/api.js's auditLog() helper, which only ever inserts - audit logs
--     should be append-only, so this is also a real security property, not
--     just tidying.
--
--   booking_locations: SELECT only. "Allow admins full access" (ALL, RLS)
--     suggests broader intent, but no client code anywhere does a direct
--     .from('booking_locations').insert/update/delete - every write goes
--     through rpc_set_booking_locations, which is SECURITY DEFINER (so it
--     writes as postgres, unaffected by the caller's own table grant).
--     js/locations.js's updateLocation() (despite its name) calls that RPC,
--     not a direct table write.
--
--   bookings: SELECT, INSERT, UPDATE. INSERT covers insertMiscBooking()
--     (js/api.js, admin-only "Add Misc" feature). No .delete() on bookings
--     exists anywhere in this repo - bookings are cancelled via a status
--     change, never hard-deleted.
--
--   email_queue: SELECT, INSERT. Queued via js/api.js's queueBulkEmail-style
--     insert; status transitions (Pending -> Processing -> Sent/Error)
--     happen entirely via claim_pending_emails() (SECURITY DEFINER) and the
--     send-email Edge Function (service_role) - no UPDATE/DELETE call site
--     exists for authenticated anywhere. js/page-email-queue.js is
--     read-only (refresh/filter/search, no write actions).
--
--   email_templates: SELECT, UPDATE. js/page-email-admin.js edits existing
--     rows only - this repo has no "create new template" UI (already noted
--     in 20260716142140's own comment), and no .delete() call site exists.
--
--   hcc_checks: SELECT, INSERT, UPDATE. js/page-hcc-dashboard.js does
--     multiple direct .update() calls (status/approval changes);
--     js/api.js's booking-status-change handler inserts a row when a
--     booking enters "HCC Checks". No .delete() call site exists.
--
--   location_power: SELECT only. "Admin manage location_power" (ALL, RLS)
--     suggests intended write capability, but zero call site of any kind
--     touches this table in this repo's client code today - narrowed to
--     match actual usage, same as the already-narrowed anon grant.
--
--   locations: SELECT only. Despite "Admin manage locations" (ALL, RLS),
--     no client code ever writes to the locations table itself - physical
--     location records (lat/lng/dataset/capacity) are seed/migration-only.
--     "Assigning" a booking to a location writes to booking_locations via
--     rpc_set_booking_locations, not this table.
--
--   payments: SELECT, UPDATE, DELETE - no INSERT. All payment-row creation
--     happens via SECURITY DEFINER RPCs (mark_stripe_payment_received,
--     finalize_stripe_confirmation, finalize_stripe_payment,
--     rpc_record_bank_transfer_payment - see 20260718090000's own trace),
--     none of which need the caller's own INSERT grant. finalizeConfirmation()
--     (js/api.js) does a genuine direct DELETE (clearing a stray payments
--     row for a free confirmation) and updatePayment() does a genuine
--     direct UPDATE - both real, both kept.
--
--   public_bookings_info, public_performer_info, public_schedule_info:
--     SELECT only on all three - "views get SELECT at most" (same rule
--     already applied to anon in 20260718100000). A view runs its internal
--     query as the view owner regardless of the caller's own grant, so
--     this only blocks authenticated from ever attempting a write against
--     the view itself; no call site does so today either.
--
-- Deliberately UNCHANGED, not part of this migration:
--   - performers, schedules: both are shared with a separate, external app
--     (ellafestperformersadmin.vercel.app per HANDOVER.md) against this
--     same Supabase project. This repo's own code never writes to either
--     table directly, but that other app's authenticated sessions might -
--     and it's outside this repo, unauditable and untestable from here.
--     Narrowing a grant a system I can't see or verify might depend on is
--     exactly the kind of cross-system risk not to take silently. Left for
--     a coordinated change with whoever maintains that app.
--   - user_roles, settings: already correctly scoped from prior work
--     (user_roles never had TRUNCATE/REFERENCES/TRIGGER to begin with;
--     settings was narrowed in 20260717100000). Nothing to change.
--   - ALTER DEFAULT PRIVILEGES for authenticated (mirroring anon's existing
--     20260717080000 fix) and the three authenticated sequence grants: each
--     a separate, differently-shaped piece of work, left for its own pass.
--
-- anon and service_role grants are untouched everywhere in this migration.

REVOKE ALL ON TABLE "public"."audit_logs" FROM "authenticated";
GRANT SELECT, INSERT ON TABLE "public"."audit_logs" TO "authenticated";

REVOKE ALL ON TABLE "public"."booking_locations" FROM "authenticated";
GRANT SELECT ON TABLE "public"."booking_locations" TO "authenticated";

REVOKE ALL ON TABLE "public"."bookings" FROM "authenticated";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."bookings" TO "authenticated";

REVOKE ALL ON TABLE "public"."email_queue" FROM "authenticated";
GRANT SELECT, INSERT ON TABLE "public"."email_queue" TO "authenticated";

REVOKE ALL ON TABLE "public"."email_templates" FROM "authenticated";
GRANT SELECT, UPDATE ON TABLE "public"."email_templates" TO "authenticated";

REVOKE ALL ON TABLE "public"."hcc_checks" FROM "authenticated";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."hcc_checks" TO "authenticated";

REVOKE ALL ON TABLE "public"."location_power" FROM "authenticated";
GRANT SELECT ON TABLE "public"."location_power" TO "authenticated";

REVOKE ALL ON TABLE "public"."locations" FROM "authenticated";
GRANT SELECT ON TABLE "public"."locations" TO "authenticated";

REVOKE ALL ON TABLE "public"."payments" FROM "authenticated";
GRANT SELECT, UPDATE, DELETE ON TABLE "public"."payments" TO "authenticated";

REVOKE ALL ON TABLE "public"."public_bookings_info" FROM "authenticated";
GRANT SELECT ON TABLE "public"."public_bookings_info" TO "authenticated";

REVOKE ALL ON TABLE "public"."public_performer_info" FROM "authenticated";
GRANT SELECT ON TABLE "public"."public_performer_info" TO "authenticated";

REVOKE ALL ON TABLE "public"."public_schedule_info" FROM "authenticated";
GRANT SELECT ON TABLE "public"."public_schedule_info" TO "authenticated";
