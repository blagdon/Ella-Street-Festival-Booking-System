-- Migration: 20260805030000_provision_display_name_override.sql
-- Round 2 operational certification, Finding 3 — every newly-provisioned
-- organisation launches showing the literal placeholder "Festival Event" as
-- its site-wide display name, not the name entered in the setup wizard.
-- rpc_initialise_tenant_defaults clones platform_defaults_settings verbatim,
-- including the seed row ('festival_display_name', 'Festival Event',
-- 'branding') added in 20260802100_create_platform_defaults.sql — nothing
-- ever substitutes the org/event name the wizard actually collected.
-- Reproduced independently on two separately-provisioned test organisations.
--
-- Fix: an optional p_display_name parameter, defaulting to NULL so every
-- existing caller keeps identical behaviour. When provided, it overrides the
-- freshly-cloned festival_display_name row for that org — the wizard's own
-- event name, not the generic template default. provision-organisation now
-- passes event_name (the public-facing festival name a trader/visitor
-- actually sees, as distinct from the organisation's own administrative
-- name) as this argument.
--
-- This function has two prior versions, not one: 20260802100 defined it
-- with ON CONFLICT (id) for email_templates/sms_templates, and
-- 20260802200_composite_pk_templates.sql (same day, later) both changed
-- those two tables to a composite (org_id, id) primary key AND redefined
-- this function's ON CONFLICT clauses to (org_id, id) to match - the
-- earlier single-column form no longer matches any constraint on the table
-- and throws 42P10 ("no unique or exclusion constraint matching the ON
-- CONFLICT specification") the moment it runs. Rebuilding this migration
-- from the wrong (superseded) starting point silently reverted that fix on
-- first attempt - caught by actually exercising provision-organisation
-- end-to-end against the test project rather than trusting a static read
-- of "the" function definition. Built from the 20260802200 version here,
-- not 20260802100.

-- Changing the signature (adding a parameter) doesn't replace the old
-- overload in place - CREATE OR REPLACE only matches on identical argument
-- types, so the original rpc_initialise_tenant_defaults(text) would
-- otherwise keep existing alongside this one, making a single-argument call
-- ambiguous between the two. Drop it explicitly first.
DROP FUNCTION IF EXISTS "public"."rpc_initialise_tenant_defaults"(text);

CREATE OR REPLACE FUNCTION "public"."rpc_initialise_tenant_defaults"(
    p_org_id text,
    p_display_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_setting_count integer := 0;
    v_email_count integer := 0;
    v_sms_count integer := 0;
BEGIN
    -- Authorization check: Admin or service role
    IF NOT (check_user_role('admin') OR current_setting('role', true) = 'service_role' OR auth.role() = 'service_role') THEN
        RAISE EXCEPTION 'Unauthorized: Admin or Service Role required';
    END IF;

    IF p_org_id IS NULL OR trim(p_org_id) = '' THEN
        RAISE EXCEPTION 'Organisation ID is required';
    END IF;

    -- Clone settings from platform_defaults_settings (DO NOTHING on conflict)
    INSERT INTO public.settings (org_id, key, value, updated_at, updated_by)
    SELECT p_org_id, key, value, now(), 'system_provisioner'
    FROM public.platform_defaults_settings
    ON CONFLICT (org_id, key) DO NOTHING;
    GET DIAGNOSTICS v_setting_count = ROW_COUNT;

    -- Clone email templates (DO NOTHING on conflict)
    INSERT INTO public.email_templates (org_id, id, subject, body_html, description, updated_at)
    SELECT p_org_id, id, subject, body_html, description, now()
    FROM public.platform_defaults_email_templates
    ON CONFLICT (org_id, id) DO NOTHING;
    GET DIAGNOSTICS v_email_count = ROW_COUNT;

    -- Clone SMS templates (DO NOTHING on conflict)
    INSERT INTO public.sms_templates (org_id, id, body, description, updated_at)
    SELECT p_org_id, id, body, description, now()
    FROM public.platform_defaults_sms_templates
    ON CONFLICT (org_id, id) DO NOTHING;
    GET DIAGNOSTICS v_sms_count = ROW_COUNT;

    -- Override the just-cloned generic placeholder with the org's actual
    -- display name, when the caller supplied one.
    IF p_display_name IS NOT NULL AND trim(p_display_name) <> '' THEN
        INSERT INTO public.settings (org_id, key, value, updated_at, updated_by)
        VALUES (p_org_id, 'festival_display_name', trim(p_display_name), now(), 'system_provisioner')
        ON CONFLICT (org_id, key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now(), updated_by = 'system_provisioner';
    END IF;

    RETURN jsonb_build_object(
        'status', 'success',
        'org_id', p_org_id,
        'settings_initialised', v_setting_count,
        'email_templates_initialised', v_email_count,
        'sms_templates_initialised', v_sms_count
    );
END;
$$;

GRANT EXECUTE ON FUNCTION "public"."rpc_initialise_tenant_defaults"(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION "public"."rpc_initialise_tenant_defaults"(text, text) TO service_role;
