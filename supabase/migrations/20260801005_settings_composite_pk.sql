-- Migration: 20260801005_settings_composite_pk.sql
-- Phase 1 — Platform Foundation: Step 6 (highest-risk migration)
--
-- Evolves the settings table primary key from (key) to (org_id, key).
-- This enables Org A and Org B to each hold their own stripe_live_secret_key,
-- stall_cost_food, bank_account_number, etc. without key collision.
--
-- Risk mitigation:
--   All existing queries use one of:
--     SELECT key, value FROM settings                   (no PK filter — still works)
--     SELECT value FROM settings WHERE key = 'foo'      (key alone still unique per org)
--     UPDATE settings SET value = ... WHERE key = 'foo' (same)
--   None of these break on a composite PK because all existing rows have
--   org_id = 'org_default' and that value is not referenced in any query.
--   The RLS anon-readable allow-list grants access to specific keys by name —
--   it does not reference the PK and is unchanged by this migration.
--
-- Verification (must pass before committing):
--   SELECT key, value FROM settings WHERE key = 'stall_cost_food';
--   → returns the correct row
--   SELECT key, value FROM settings;
--   → returns all rows (same count as before)
--   loadStallCosts() on any admin page → correct stall costs shown
--
-- Backwards compatibility guarantee:
--   No existing query is broken. The settings table returns the same rows
--   for all existing SELECT patterns. INSERT and UPDATE patterns using only
--   WHERE key = '...' continue to work because key remains unique per org,
--   and all Phase 1 rows share org_id = 'org_default'.

-- Step 1: Add org_id with a default.
-- All existing rows immediately become (org_id='org_default', key=<existing key>).
ALTER TABLE "public"."settings"
    ADD COLUMN IF NOT EXISTS "org_id" text NOT NULL DEFAULT 'org_default';

COMMENT ON COLUMN "public"."settings"."org_id" IS
    'Organisation (tenant) scope. Phase 1: always org_default. '
    'Phase 2: each organisation holds its own settings rows. '
    'Reads must eventually include WHERE org_id = get_current_org_id() — '
    'this is Phase 2 work; do not add that filter until RLS isolation is active.';

-- Step 2: Swap the primary key.
-- The new (org_id, key) composite is guaranteed unique because all existing rows
-- have the same org_id and key was already unique.
ALTER TABLE "public"."settings" DROP CONSTRAINT IF EXISTS "settings_pkey";
ALTER TABLE "public"."settings" ADD CONSTRAINT "settings_pkey" PRIMARY KEY ("org_id", "key");

COMMENT ON TABLE "public"."settings" IS
    'Runtime key/value configuration, scoped per organisation. '
    'Phase 1: all rows have org_id = org_default. '
    'Phase 2: each organisation gets its own settings rows; '
    'loadStallCosts() is updated to filter WHERE org_id = get_current_org_id().';

CREATE INDEX IF NOT EXISTS "idx_settings_org_id" ON "public"."settings" ("org_id");
