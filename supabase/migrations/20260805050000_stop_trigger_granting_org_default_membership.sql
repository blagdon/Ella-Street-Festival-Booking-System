-- Migration: 20260805050000_stop_trigger_granting_org_default_membership.sql
-- Launch Readiness Review — a defect more fundamental than the five
-- originally-scoped findings, found while implementing the fix for them.
--
-- sync_organisation_members_from_user_roles() (added in
-- 20260801003_create_organisation_members.sql, for a Phase-1 world where
-- org_default really was the only organisation) fires on every INSERT or
-- UPDATE to user_roles and unconditionally grants the affected user admin
-- membership in org_default, regardless of which organisation the write was
-- actually for:
--
--   INSERT INTO public.organisation_members (org_id, user_id, role)
--   VALUES ('org_default', NEW.id, NEW.role::text)
--   ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role;
--
-- provision-organisation upserts a user_roles row for every new
-- organisation's owner (kept for backwards compatibility with the several
-- SECURITY DEFINER RPCs that still read user_roles directly — see that
-- migration's own comments on Phase 2 not being complete yet). Every one of
-- those upserts fires this trigger, which then grants that owner admin
-- rights on org_default — the real, primary organisation — as an entirely
-- unintended side effect of provisioning an UNRELATED organisation.
--
-- Confirmed live in the test project: 5 independent test-organisation owner
-- accounts (including 44 accumulated rollback-test-* organisations from
-- provisioning-rollback integration test runs) all hold genuine admin
-- membership in org_default this way. Confirmed in production on a smaller
-- but real scale: one account was an unintended org_default admin as a
-- result of this exact mechanism, corrected by hand alongside this
-- migration; every other production account was placed in user_roles by
-- the intentional path this fix preserves (see below) and needed no change.
--
-- Fix: stop the trigger from ever GRANTING new org_default membership as a
-- side effect. It now only keeps an EXISTING org_default membership row in
-- sync (role changes, removal) — never creates one. The one legitimate
-- caller that relied on the implicit grant, manage_users.html's "create
-- account" flow (js/page-manage-users.js), now writes that membership
-- itself, explicitly, matching the pattern every other member-creation path
-- in this codebase already follows (provision-organisation,
-- invite-organisation-member). Do not redesign further than that: user_roles
-- itself is left exactly as it was, for the same Phase-2-not-complete
-- reasons the original migration gave.
CREATE OR REPLACE FUNCTION "public"."sync_organisation_members_from_user_roles"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE public.organisation_members
        SET role = NEW.role::text
        WHERE org_id = 'org_default' AND user_id = NEW.id;
        RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
        UPDATE public.organisation_members
        SET role = NEW.role::text
        WHERE org_id = 'org_default' AND user_id = NEW.id;
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
    'Keeps an EXISTING org_default organisation_members row in sync with '
    'user_roles (role changes, removal) - deliberately never grants new '
    'org_default membership as a side effect of an unrelated user_roles '
    'write, which is what let every provisioned organisation''s owner end '
    'up an org_default admin too. New org_default members must be added '
    'explicitly (js/page-manage-users.js), same as every other '
    'organisation''s members already are.';

-- is_platform_admin() itself was the deeper reason the fix above matters:
-- every one of its current call sites (organisations/settings RLS from the
-- Round 2 certification fixes, rpc_get_organisation, and today's
-- bookings/locations/events/templates policies - confirmed by grep, every
-- single usage across this codebase was introduced in one of those two
-- fixing passes) checked the raw global user_roles table directly. That
-- table is NOT restricted to genuine platform-wide staff - provisioning
-- upserts a row there for every new organisation's owner too, for reasons
-- unrelated to platform administration (several legacy RPCs still read
-- user_roles as their primary or only admin check). So is_platform_admin()
-- has, in practice, meant "is admin of literally any organisation", not
-- "is a genuine cross-tenant platform administrator" - silently
-- undermining every policy that relied on it as the deliberate, narrow
-- bypass, including the ones fixed earlier today.
--
-- Redefined to check org_default's organisation_members instead: after the
-- fix above, that table only ever gains a new org_default row through an
-- explicit, deliberate add (manage_users.html, or genuine org_default
-- administration) - exactly the "genuine platform-wide admin" concept this
-- function's own name and original doc comment already claimed to
-- implement. Confirmed safe for the real platform staff: every currently
-- recognised platform admin (org_default's actual organisation_members
-- admins) is unaffected by this change; only organisations that were never
-- genuinely org_default members lose the bypass they were never supposed
-- to have.
CREATE OR REPLACE FUNCTION "public"."is_platform_admin"()
RETURNS boolean
LANGUAGE "sql" STABLE SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
    SELECT EXISTS (
        SELECT 1 FROM "public"."organisation_members"
        WHERE "user_id" = "auth"."uid"()
          AND "org_id" = 'org_default'
          AND "role" = 'admin'
    );
$$;
