-- Migration: 20260801004_add_tenant_columns_to_domain_tables.sql
-- Phase 1 — Platform Foundation: Step 5
--
-- Adds org_id and event_id columns to all domain tables as NOT NULL with
-- DEFAULT values matching the Phase 1 seed rows. Every existing row is
-- immediately valid. Every existing INSERT that does not specify these
-- columns continues to work without change — the defaults are applied
-- transparently by Postgres.
--
-- Tables excluded from this migration (see implementation_plan.md §2):
--   performers, schedules  — managed by an external application
--   stripe_webhook_events  — idempotency ledger, no tenant dimension needed
--   google_reviews_cache   — single-key cache, no tenant dimension needed
--   user_roles             — security foundation, unchanged throughout Phase 1
--   organisations          — is the tenant root, no self-reference needed
--   events                 — already has org_id from creation
--   organisation_members   — already has org_id from creation
--
-- Backwards compatibility guarantee:
--   No existing column is renamed or dropped. No existing query, RLS policy,
--   RPC, Edge Function, or JS module is broken. loadStallCosts() does
--   SELECT key, value FROM settings — still returns all rows because all rows
--   have org_id = 'org_default'. The application behaves identically.

-- ── bookings ────────────────────────────────────────────────────────────────
ALTER TABLE "public"."bookings"
    ADD COLUMN IF NOT EXISTS "org_id"   text NOT NULL DEFAULT 'org_default',
    ADD COLUMN IF NOT EXISTS "event_id" text NOT NULL DEFAULT 'event_default';

COMMENT ON COLUMN "public"."bookings"."org_id" IS
    'Organisation (tenant) scope. Phase 1: always org_default. '
    'Phase 2: per-organisation isolation enforced via RLS.';

COMMENT ON COLUMN "public"."bookings"."event_id" IS
    'Event scope. Phase 1: always event_default. '
    'Phase 2: per-event scoping. '
    'NOTE: Does NOT replace instance_prefix — see implementation_plan.md §3.1. '
    'instance_prefix remains the active filter mechanism throughout Phase 1.';

-- ── locations ────────────────────────────────────────────────────────────────
ALTER TABLE "public"."locations"
    ADD COLUMN IF NOT EXISTS "org_id"   text NOT NULL DEFAULT 'org_default',
    ADD COLUMN IF NOT EXISTS "event_id" text NOT NULL DEFAULT 'event_default';

COMMENT ON COLUMN "public"."locations"."org_id" IS
    'Organisation (tenant) scope. Phase 1: always org_default.';

COMMENT ON COLUMN "public"."locations"."event_id" IS
    'Event scope. Phase 1: always event_default. '
    'Replaces the dataset column''s DEV/LIVE separation in Phase 2, '
    'once instance_prefix is migrated.';

-- ── email_templates ──────────────────────────────────────────────────────────
-- email_templates are per-organisation but not per-event in Phase 1.
-- Per-event templates (different wording for each festival year) are Phase 2.
ALTER TABLE "public"."email_templates"
    ADD COLUMN IF NOT EXISTS "org_id" text NOT NULL DEFAULT 'org_default';

COMMENT ON COLUMN "public"."email_templates"."org_id" IS
    'Organisation scope. Phase 1: always org_default. '
    'Templates are not yet scoped per-event — that is Phase 2.';

-- ── sms_templates ────────────────────────────────────────────────────────────
ALTER TABLE "public"."sms_templates"
    ADD COLUMN IF NOT EXISTS "org_id" text NOT NULL DEFAULT 'org_default';

COMMENT ON COLUMN "public"."sms_templates"."org_id" IS
    'Organisation scope. Phase 1: always org_default.';

-- ── audit_logs ───────────────────────────────────────────────────────────────
ALTER TABLE "public"."audit_logs"
    ADD COLUMN IF NOT EXISTS "org_id"   text NOT NULL DEFAULT 'org_default',
    ADD COLUMN IF NOT EXISTS "event_id" text NOT NULL DEFAULT 'event_default';

COMMENT ON COLUMN "public"."audit_logs"."org_id" IS
    'Organisation scope for the audit trail. Phase 1: always org_default. '
    'Phase 2: each organisation sees only its own audit trail.';

COMMENT ON COLUMN "public"."audit_logs"."event_id" IS
    'Event scope for the audit trail. Phase 1: always event_default.';

-- ── hcc_checks ───────────────────────────────────────────────────────────────
ALTER TABLE "public"."hcc_checks"
    ADD COLUMN IF NOT EXISTS "org_id"   text NOT NULL DEFAULT 'org_default',
    ADD COLUMN IF NOT EXISTS "event_id" text NOT NULL DEFAULT 'event_default';

COMMENT ON COLUMN "public"."hcc_checks"."org_id" IS
    'Organisation scope. Phase 1: always org_default.';

-- ── payments ─────────────────────────────────────────────────────────────────
-- payments is linked to bookings via booking_id; org_id here mirrors
-- bookings.org_id and must never be set independently.
ALTER TABLE "public"."payments"
    ADD COLUMN IF NOT EXISTS "org_id" text NOT NULL DEFAULT 'org_default';

COMMENT ON COLUMN "public"."payments"."org_id" IS
    'Organisation scope. Phase 1: always org_default. '
    'Must mirror bookings.org_id for the related booking — '
    'never set this independently.';

-- ── email_queue ──────────────────────────────────────────────────────────────
ALTER TABLE "public"."email_queue"
    ADD COLUMN IF NOT EXISTS "org_id" text NOT NULL DEFAULT 'org_default';

COMMENT ON COLUMN "public"."email_queue"."org_id" IS
    'Organisation scope. Phase 1: always org_default. '
    'email_queue.instance_prefix already exists for booking-type separation; '
    'org_id is the tenant-level equivalent added here for Phase 2.';

-- ── sms_queue ────────────────────────────────────────────────────────────────
ALTER TABLE "public"."sms_queue"
    ADD COLUMN IF NOT EXISTS "org_id" text NOT NULL DEFAULT 'org_default';

COMMENT ON COLUMN "public"."sms_queue"."org_id" IS
    'Organisation scope. Phase 1: always org_default.';

-- ── indexes ──────────────────────────────────────────────────────────────────
-- Not performance-critical at current data volumes (~200 bookings) but
-- required before Phase 2 adds WHERE org_id = get_current_org_id() to
-- RLS policies — without indexes those policies scan the full table.
CREATE INDEX IF NOT EXISTS "idx_bookings_org_id"          ON "public"."bookings"        ("org_id");
CREATE INDEX IF NOT EXISTS "idx_bookings_event_id"        ON "public"."bookings"        ("event_id");
CREATE INDEX IF NOT EXISTS "idx_locations_org_id"         ON "public"."locations"       ("org_id");
CREATE INDEX IF NOT EXISTS "idx_locations_event_id"       ON "public"."locations"       ("event_id");
CREATE INDEX IF NOT EXISTS "idx_email_templates_org_id"   ON "public"."email_templates" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_sms_templates_org_id"     ON "public"."sms_templates"   ("org_id");
CREATE INDEX IF NOT EXISTS "idx_audit_logs_org_id"        ON "public"."audit_logs"      ("org_id");
CREATE INDEX IF NOT EXISTS "idx_audit_logs_event_id"      ON "public"."audit_logs"      ("event_id");
CREATE INDEX IF NOT EXISTS "idx_hcc_checks_org_id"        ON "public"."hcc_checks"      ("org_id");
CREATE INDEX IF NOT EXISTS "idx_hcc_checks_event_id"      ON "public"."hcc_checks"      ("event_id");
CREATE INDEX IF NOT EXISTS "idx_payments_org_id"          ON "public"."payments"        ("org_id");
CREATE INDEX IF NOT EXISTS "idx_email_queue_org_id"       ON "public"."email_queue"     ("org_id");
CREATE INDEX IF NOT EXISTS "idx_sms_queue_org_id"         ON "public"."sms_queue"       ("org_id");
