-- Migration: 20260802200_composite_pk_templates.sql
-- Updates email_templates and sms_templates to use composite PK (org_id, id) for tenant isolation.

ALTER TABLE "public"."email_templates" DROP CONSTRAINT IF EXISTS "email_templates_pkey";
ALTER TABLE "public"."email_templates" ADD PRIMARY KEY ("org_id", "id");

ALTER TABLE "public"."sms_templates" DROP CONSTRAINT IF EXISTS "sms_templates_pkey";
ALTER TABLE "public"."sms_templates" ADD PRIMARY KEY ("org_id", "id");

-- Update RPC: Initialise Tenant Defaults with ON CONFLICT (org_id, id)
CREATE OR REPLACE FUNCTION "public"."rpc_initialise_tenant_defaults"(
    p_org_id text
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

    -- Clone settings from platform_defaults_settings
    INSERT INTO public.settings (org_id, key, value, updated_at, updated_by)
    SELECT p_org_id, key, value, now(), 'system_provisioner'
    FROM public.platform_defaults_settings
    ON CONFLICT (org_id, key) DO NOTHING;
    GET DIAGNOSTICS v_setting_count = ROW_COUNT;

    -- Clone email templates
    INSERT INTO public.email_templates (org_id, id, subject, body_html, description, updated_at)
    SELECT p_org_id, id, subject, body_html, description, now()
    FROM public.platform_defaults_email_templates
    ON CONFLICT (org_id, id) DO NOTHING;
    GET DIAGNOSTICS v_email_count = ROW_COUNT;

    -- Clone SMS templates
    INSERT INTO public.sms_templates (org_id, id, body, description, updated_at)
    SELECT p_org_id, id, body, description, now()
    FROM public.platform_defaults_sms_templates
    ON CONFLICT (org_id, id) DO NOTHING;
    GET DIAGNOSTICS v_sms_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'status', 'success',
        'org_id', p_org_id,
        'settings_initialised', v_setting_count,
        'email_templates_initialised', v_email_count,
        'sms_templates_initialised', v_sms_count
    );
END;
$$;

GRANT EXECUTE ON FUNCTION "public"."rpc_initialise_tenant_defaults"(text) TO authenticated;
GRANT EXECUTE ON FUNCTION "public"."rpc_initialise_tenant_defaults"(text) TO service_role;
