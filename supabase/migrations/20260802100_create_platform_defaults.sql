-- Migration: 20260802100_create_platform_defaults.sql
-- Epic 3 Platform Provisioning: Creates platform defaults tables, event lifecycle status, and tenant initialisation RPC.

-- 1. Add status column to events table
ALTER TABLE "public"."events"
    ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'draft'
    CONSTRAINT "events_status_check" CHECK (status IN ('draft', 'ready', 'open', 'closed', 'archived'));

-- 2. Create Platform Defaults Settings table
CREATE TABLE IF NOT EXISTS "public"."platform_defaults_settings" (
    "key"         text PRIMARY KEY,
    "value"       text NOT NULL,
    "category"    text NOT NULL DEFAULT 'general'
);

-- 3. Create Platform Defaults Email Templates table
CREATE TABLE IF NOT EXISTS "public"."platform_defaults_email_templates" (
    "id"          text PRIMARY KEY,
    "subject"     text NOT NULL,
    "body_html"   text NOT NULL,
    "description" text NOT NULL
);

-- 4. Create Platform Defaults SMS Templates table
CREATE TABLE IF NOT EXISTS "public"."platform_defaults_sms_templates" (
    "id"          text PRIMARY KEY,
    "body"        text NOT NULL,
    "description" text NOT NULL
);

-- RLS: Platform defaults are readable by authenticated staff and service role
ALTER TABLE "public"."platform_defaults_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."platform_defaults_email_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."platform_defaults_sms_templates" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read platform_defaults_settings" ON "public"."platform_defaults_settings" FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read platform_defaults_email_templates" ON "public"."platform_defaults_email_templates" FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read platform_defaults_sms_templates" ON "public"."platform_defaults_sms_templates" FOR SELECT TO authenticated USING (true);

GRANT SELECT ON TABLE "public"."platform_defaults_settings" TO authenticated;
GRANT SELECT ON TABLE "public"."platform_defaults_email_templates" TO authenticated;
GRANT SELECT ON TABLE "public"."platform_defaults_sms_templates" TO authenticated;

GRANT ALL ON TABLE "public"."platform_defaults_settings" TO service_role;
GRANT ALL ON TABLE "public"."platform_defaults_email_templates" TO service_role;
GRANT ALL ON TABLE "public"."platform_defaults_sms_templates" TO service_role;

-- 5. Seed Platform Defaults Data
INSERT INTO "public"."platform_defaults_settings" (key, value, category) VALUES
    ('festival_display_name', 'Festival Event', 'branding'),
    ('primary_color', '#2563EB', 'branding'),
    ('accent_color', '#3B82F6', 'branding'),
    ('support_email', 'support@example.co.uk', 'branding'),
    ('stall_cost_food', '150.00', 'pricing'),
    ('stall_cost_general', '75.00', 'pricing'),
    ('stall_cost_dev', '0.00', 'pricing'),
    ('allowed_stall_types', 'Food,General,Crafts,Charity', 'booking'),
    ('sms_provider', 'twilio', 'messaging'),
    ('sms_test_mode', 'true', 'messaging')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, category = EXCLUDED.category;

INSERT INTO "public"."platform_defaults_email_templates" (id, subject, body_html, description) VALUES
    ('application_received', 'Application Received - {{business_name}}', '<h1>Application Received</h1><p>Thank you for submitting your booking application for {{business_name}}.</p>', 'Sent automatically upon booking submission'),
    ('confirmed_chargeable', 'Booking Confirmed - {{business_name}}', '<h1>Booking Confirmed</h1><p>Your booking {{booking_id}} has been approved.</p>', 'Sent when booking status is updated to Confirmed'),
    ('payment_requested', 'Payment Requested - {{booking_id}}', '<h1>Payment Requested</h1><p>Please complete payment using the link below:</p><p><a href="{{payment_url}}">Pay Now</a></p>', 'Sent when payment link is generated'),
    ('cancellation_confirmed', 'Booking Cancelled - {{booking_id}}', '<h1>Booking Cancelled</h1><p>Your booking {{booking_id}} has been cancelled.</p>', 'Sent when booking is cancelled')
ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, body_html = EXCLUDED.body_html, description = EXCLUDED.description;

INSERT INTO "public"."platform_defaults_sms_templates" (id, body, description) VALUES
    ('booking_received', 'Thanks for your application to {{event_name}}! Ref: {{booking_id}}', 'Sent when booking application is submitted'),
    ('payment_requested', 'Payment requested for {{event_name}} (Ref: {{booking_id}}). Link: {{payment_url}}', 'Sent when payment link is generated'),
    ('cancellation_confirmed', 'Your booking {{booking_id}} for {{event_name}} has been cancelled.', 'Sent when booking is cancelled')
ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, description = EXCLUDED.description;

-- 6. RPC: Initialise Tenant Defaults
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
    ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
    GET DIAGNOSTICS v_setting_count = ROW_COUNT;

    -- Clone email templates
    INSERT INTO public.email_templates (org_id, id, subject, body_html, description, updated_at)
    SELECT p_org_id, id, subject, body_html, description, now()
    FROM public.platform_defaults_email_templates
    ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, body_html = EXCLUDED.body_html, description = EXCLUDED.description, updated_at = now();
    GET DIAGNOSTICS v_email_count = ROW_COUNT;

    -- Clone SMS templates
    INSERT INTO public.sms_templates (org_id, id, body, description, updated_at)
    SELECT p_org_id, id, body, description, now()
    FROM public.platform_defaults_sms_templates
    ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, description = EXCLUDED.description, updated_at = now();
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
