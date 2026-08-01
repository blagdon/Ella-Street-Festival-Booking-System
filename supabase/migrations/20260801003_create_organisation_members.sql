-- Migration: 20260801003_create_organisation_members.sql
-- Phase 1 — Platform Foundation: Step 4
--
-- Creates organisation_members as an ADDITIVE table alongside user_roles.
-- user_roles remains the single authoritative source for all SECURITY DEFINER
-- RPCs, check_user_role(), and every RLS policy throughout Phase 1.
--
-- Why additive and not a replacement?
--   Seven SECURITY DEFINER RPCs (rpc_set_booking_locations,
--   rpc_record_bank_transfer_payment, rpc_record_refund,
--   rpc_get_next_misc_id, cancel_booking_secure, etc.) and every RLS policy
--   that protects bookings/payments/locations read user_roles directly.
--   Migrating each one individually — with a test proving identical behaviour
--   before and after — is Phase 2 work. Doing it in Phase 1 would touch the
--   core security enforcement of the live application with no incremental
--   safety net.
--
-- This table is backfilled from user_roles so it is immediately consistent.
-- If a user is added via manage_users.html during Phase 1, a trigger below
-- keeps organisation_members in sync automatically, preventing silent drift.
--
-- Backwards compatibility guarantee:
--   user_roles is not altered. No existing RPC or RLS policy references this
--   table. The application behaves identically after deployment.

CREATE TABLE IF NOT EXISTS "public"."organisation_members" (
    "id"         uuid        NOT NULL DEFAULT gen_random_uuid(),
    "org_id"     text        NOT NULL REFERENCES "public"."organisations" ("id"),
    "user_id"    uuid        NOT NULL,
    "role"       text        NOT NULL CHECK (role IN ('admin', 'steward')),
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "organisation_members_pkey"            PRIMARY KEY ("id"),
    CONSTRAINT "organisation_members_org_user_unique" UNIQUE ("org_id", "user_id")
);

ALTER TABLE "public"."organisation_members" OWNER TO postgres;

COMMENT ON TABLE "public"."organisation_members" IS
    'Membership table mapping auth users to organisations with a role. '
    'Phase 1: additive only alongside user_roles. user_roles remains the '
    'authoritative source for all SECURITY DEFINER RPCs and RLS policies. '
    'Backfilled from user_roles and kept in sync via trigger. '
    'Phase 2: RPCs migrated one at a time from user_roles to this table, '
    'each with a passing test before the switch.';

ALTER TABLE "public"."organisation_members" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read organisation_members"
    ON "public"."organisation_members"
    FOR SELECT
    USING (check_user_role('admin'));

-- Sync trigger: when manage_users.html inserts/updates/deletes a user_roles
-- row, organisation_members is kept consistent automatically.
-- This prevents silent drift during Phase 1 while user_roles is still live.
CREATE OR REPLACE FUNCTION "public"."sync_organisation_members_from_user_roles"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.organisation_members (org_id, user_id, role)
        VALUES ('org_default', NEW.id, NEW.role::text)
        ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role;
        RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO public.organisation_members (org_id, user_id, role)
        VALUES ('org_default', NEW.id, NEW.role::text)
        ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role;
        RETURN NEW;

    ELSIF TG_OP = 'DELETE' THEN
        DELETE FROM public.organisation_members
        WHERE org_id = 'org_default' AND user_id = OLD.id;
        RETURN OLD;
    END IF;

    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION "public"."sync_organisation_members_from_user_roles"() IS
    'Keeps organisation_members in sync with user_roles during Phase 1. '
    'Phase 2: once organisation_members is the authoritative source and all '
    'RPCs are migrated, this trigger is dropped and the direction reverses '
    '(user_roles becomes the follower, or is dropped entirely).';

CREATE OR REPLACE TRIGGER "trg_sync_organisation_members"
    AFTER INSERT OR UPDATE OR DELETE ON "public"."user_roles"
    FOR EACH ROW EXECUTE FUNCTION "public"."sync_organisation_members_from_user_roles"();

-- Backfill from user_roles so the table is immediately consistent.
-- ON CONFLICT DO NOTHING makes this idempotent on re-run.
INSERT INTO "public"."organisation_members" (org_id, user_id, role)
SELECT 'org_default', id, role::text
FROM "public"."user_roles"
ON CONFLICT (org_id, user_id) DO NOTHING;

GRANT ALL    ON TABLE "public"."organisation_members" TO service_role;
GRANT SELECT ON TABLE "public"."organisation_members" TO authenticated;
REVOKE ALL   ON TABLE "public"."organisation_members" FROM anon;
