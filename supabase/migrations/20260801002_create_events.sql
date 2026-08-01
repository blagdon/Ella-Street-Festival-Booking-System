-- Migration: 20260801002_create_events.sql
-- Phase 1 — Platform Foundation: Step 3
--
-- Creates the events table — one festival event per organisation.
-- Phase 1: one row only (event_default = Ella Street Festival 2026).
-- Phase 2: multiple events per organisation (multi-year, multi-festival).
--
-- IMPORTANT — instance_prefix is NOT migrated by this step.
-- The bookings.instance_prefix column (e.g. 'ESF26-FOOD-') remains the
-- active filter mechanism throughout Phase 1. The migration from
-- instance_prefix to event_id as a live FK is Phase 2 work and cannot
-- happen until this events table exists to reference — which is why this
-- table is created now. See implementation_plan.md §3 and §6.1.
--
-- Backwards compatibility guarantee:
--   No existing table, column, RLS policy, or RPC is altered by this migration.
--   The application behaves identically after deployment.

CREATE TABLE IF NOT EXISTS "public"."events" (
    "id"             text        NOT NULL,
    "org_id"         text        NOT NULL REFERENCES "public"."organisations" ("id"),
    "name"           text        NOT NULL,
    "slug"           text        NOT NULL,
    "booking_prefix" text        NOT NULL DEFAULT 'ESF26',
    "is_active"      boolean     NOT NULL DEFAULT true,
    "created_at"     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "events_pkey"        PRIMARY KEY ("id"),
    CONSTRAINT "events_slug_unique" UNIQUE      ("org_id", "slug")
);

ALTER TABLE "public"."events" OWNER TO postgres;

COMMENT ON TABLE "public"."events" IS
    'A festival event owned by an organisation. '
    'Phase 1: single row (event_default = Ella Street Festival 2026). '
    'booking_prefix mirrors settings.booking_prefix and is held here for '
    'future per-event overrides. '
    'Does NOT yet replace instance_prefix on bookings — that is Phase 2. '
    'See implementation_plan.md §3.1 and §6.1.';

COMMENT ON COLUMN "public"."events"."booking_prefix" IS
    'The year/event prefix used in booking IDs (e.g. ESF26). '
    'Phase 1: always ESF26, mirroring settings.booking_prefix. '
    'Phase 2: each event can override this independently.';

ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read events"
    ON "public"."events"
    FOR SELECT
    USING (check_user_role('admin'));

-- Seed the single Phase 1 event.
-- booking_prefix matches the current settings.booking_prefix value (ESF26).
-- ON CONFLICT DO NOTHING makes this migration idempotent.
INSERT INTO "public"."events" (id, org_id, name, slug, booking_prefix, is_active)
VALUES ('event_default', 'org_default', 'Ella Street Festival 2026', 'esf-2026', 'ESF26', true)
ON CONFLICT (id) DO NOTHING;

GRANT ALL    ON TABLE "public"."events" TO service_role;
GRANT SELECT ON TABLE "public"."events" TO authenticated;
REVOKE ALL   ON TABLE "public"."events" FROM anon;
