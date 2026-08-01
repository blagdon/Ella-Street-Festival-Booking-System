-- Migration: 20260801001_create_organisations.sql
-- Phase 1 — Platform Foundation: Step 2
--
-- Creates the top-level tenant entity.
-- Phase 1: one row only (org_default = Ella Street Festival).
-- Phase 2: additional rows per paying customer organisation.
--
-- Backwards compatibility guarantee:
--   No existing table, column, RLS policy, or RPC is altered by this migration.
--   The application behaves identically after deployment.

CREATE TABLE IF NOT EXISTS "public"."organisations" (
    "id"         text        NOT NULL,
    "name"       text        NOT NULL,
    "slug"       text        NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "organisations_pkey"        PRIMARY KEY ("id"),
    CONSTRAINT "organisations_slug_unique" UNIQUE      ("slug")
);

ALTER TABLE "public"."organisations" OWNER TO postgres;

COMMENT ON TABLE "public"."organisations" IS
    'Top-level tenant entity. '
    'Phase 1: single row (org_default = Ella Street Festival). '
    'Phase 2: one row per customer organisation.';

-- RLS: admins can read their own organisation.
-- Anon has no access. Phase 2 adds insert/update policies when
-- organisation onboarding and self-service management is introduced.
ALTER TABLE "public"."organisations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read organisations"
    ON "public"."organisations"
    FOR SELECT
    USING (check_user_role('admin'));

-- Seed the single Phase 1 organisation.
-- ON CONFLICT DO NOTHING makes this migration idempotent.
INSERT INTO "public"."organisations" (id, name, slug)
VALUES ('org_default', 'Ella Street Festival', 'ella-street')
ON CONFLICT (id) DO NOTHING;

-- Grants mirror the pattern used by all existing tables in this project.
GRANT ALL   ON TABLE "public"."organisations" TO service_role;
GRANT SELECT ON TABLE "public"."organisations" TO authenticated;
REVOKE ALL   ON TABLE "public"."organisations" FROM anon;
