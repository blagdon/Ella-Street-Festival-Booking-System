-- Phase 2B — remove the 13 transitional tenant-scope column defaults.
--
-- The Phase 2 tenant-scope DEFAULT audit (read-only investigation) and the
-- Phase 2A preparation pass established: every live production/seed insert
-- path already supplies org_id/event_id explicitly on all 13 columns below;
-- the defaults are inert scaffolding left over from the original Phase 1 ->
-- Phase 2 migration strategy (20260801004_add_tenant_columns_to_domain_tables.sql,
-- 20260801005_settings_composite_pk.sql), not something any current code
-- path relies on. Leaving them in place is a live landmine — the exact
-- shape of bug that already caused one real incident
-- (`booking_type DEFAULT 'dev'` silently mislabeling Misc bookings) and one
-- narrowly-missed one (create-checkout-session's event_id gap, PR #224).
--
-- This migration does exactly one thing, 13 times: DROP DEFAULT. It does
-- NOT touch NOT NULL, does not add/remove any constraint, index, trigger,
-- FK, RLS policy, or grant, and does not change any column's type. An
-- INSERT that already supplies the value is completely unaffected; an
-- INSERT that omits it will now fail with a NOT NULL violation instead of
-- silently landing on 'org_default'/'event_default'.
--
-- Deliberately NOT bundled into this migration (each is separate, later,
-- or already-separate work):
--   - the comment-refresh migration (20260821100000) — independent,
--     reviewed separately, not applied as part of this change;
--   - the composite-FK work tying bookings/locations.org_id to their own
--     event's real owning organisation — a schema-shape change, not a
--     default removal;
--   - the event_settings provisioning gap (no seed path writes a row at
--     provisioning time at all) — unrelated to this column's default;
--   - performers/schedules/user_roles, storage RLS, DEV/Stripe mechanisms,
--     HCC, provisioning/event activation, booking_prefix — all untouched.

ALTER TABLE "public"."bookings" ALTER COLUMN "org_id" DROP DEFAULT;
ALTER TABLE "public"."bookings" ALTER COLUMN "event_id" DROP DEFAULT;
ALTER TABLE "public"."locations" ALTER COLUMN "org_id" DROP DEFAULT;
ALTER TABLE "public"."locations" ALTER COLUMN "event_id" DROP DEFAULT;
ALTER TABLE "public"."payments" ALTER COLUMN "org_id" DROP DEFAULT;
ALTER TABLE "public"."audit_logs" ALTER COLUMN "org_id" DROP DEFAULT;
ALTER TABLE "public"."audit_logs" ALTER COLUMN "event_id" DROP DEFAULT;
ALTER TABLE "public"."email_queue" ALTER COLUMN "org_id" DROP DEFAULT;
ALTER TABLE "public"."sms_queue" ALTER COLUMN "org_id" DROP DEFAULT;
ALTER TABLE "public"."email_templates" ALTER COLUMN "org_id" DROP DEFAULT;
ALTER TABLE "public"."sms_templates" ALTER COLUMN "org_id" DROP DEFAULT;
ALTER TABLE "public"."settings" ALTER COLUMN "org_id" DROP DEFAULT;
ALTER TABLE "public"."event_settings" ALTER COLUMN "event_id" DROP DEFAULT;
