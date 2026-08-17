-- Migration: 20260817100000_retire_hcc_checks.sql
-- Complete retirement of the HCC Checks feature (Hull City Council
-- food-safety compliance-tracking workflow).
--
-- Investigation summary (full report delivered separately): HCC Checks is a
-- self-contained, non-gating feature — a bookings.status value ('HCC
-- Checks'), a dedicated tracking table (hcc_checks), a dashboard
-- (hcc_dashboard.html), and an auto-insert linkage in updateBookingStatus().
-- No RPC, view, trigger, or Edge Function has a hard dependency on it;
-- create-checkout-session explicitly permits requesting payment from a
-- booking sitting in 'HCC Checks' status, and no code path anywhere reads
-- hcc_checks.council_status before allowing another action to proceed. In
-- production, all 6 existing hcc_checks rows are historical/abandoned (a
-- single 13-day batch in July 2026, 5 of 6 never resolved, no activity
-- since) and zero bookings currently sit in 'HCC Checks' status. Retirement
-- approved; the existing hcc_checks rows (production and any test-project
-- fixtures) are explicitly classified as disposable test data and are not
-- archived.
--
-- This migration does NOT touch general Hull City Council/regulatory
-- functionality: regulatory_authority_name, insurance_minimum_amount, and
-- the public regulatory-declaration flow are untouched. It does not touch
-- any other booking status, Stripe/DEV mechanisms, or multi-event
-- architecture (org/event scoping, RLS helper functions, other RPCs).
--
-- Steps, in dependency order:
--   1. Any booking currently sitting in 'HCC Checks' status is moved to
--      'Pending' — required before the CHECK constraint can drop the value;
--      a generic, idempotent UPDATE safe to run in any environment (0 rows
--      affected in production today; 1 fixture row in the test project as
--      of this writing).
--   2. Drop hcc_checks entirely (CASCADE removes its FK, indexes, RLS
--      policy, and grants along with it — confirmed via pg_policy/
--      information_schema.role_table_grants that nothing else references
--      this table).
--   3. Remove 'HCC Checks' from the bookings.status CHECK constraint,
--      leaving the other five values (Pending, Payment Requested,
--      Confirmed, Rejected, Cancelled) unchanged.
--   4. Remove the hcc_batch_check email template from both email_templates
--      (per-org data) and platform_defaults_email_templates (provisioning
--      seed) — no other template shares this id.
--   5. Remove the hcc_council_email setting from settings, event_settings,
--      and platform_defaults_settings — no other setting shares this key.
--   6. Re-create rpc_get_public_settings / rpc_get_public_event_settings
--      (Phase 3 WP2, 20260815220000) with 'hcc_council_email' dropped from
--      their fixed allow-list arrays. This is the only place the key was
--      still reachable after step 5 — the two RPCs are shared public-
--      settings infrastructure and are NOT dropped, only their allow-list
--      literal is updated. Every other key in both arrays is unchanged,
--      including regulatory_authority_name and insurance_minimum_amount.

-- ---------------------------------------------------------------------
-- 1. Move any booking out of the 'HCC Checks' status ahead of the
--    constraint change.
-- ---------------------------------------------------------------------
UPDATE public.bookings
SET status = 'Pending'
WHERE status = 'HCC Checks';

-- ---------------------------------------------------------------------
-- 2. Drop the hcc_checks table (FK, indexes, RLS policy, grants all
--    cascade with it).
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS public.hcc_checks;

-- ---------------------------------------------------------------------
-- 3. Narrow the bookings status CHECK constraint.
-- ---------------------------------------------------------------------
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE public.bookings
    ADD CONSTRAINT bookings_status_check
    CHECK (status = ANY (ARRAY[
        'Pending'::text,
        'Payment Requested'::text,
        'Confirmed'::text,
        'Rejected'::text,
        'Cancelled'::text
    ]));

-- ---------------------------------------------------------------------
-- 4. Remove the HCC-specific email template.
-- ---------------------------------------------------------------------
DELETE FROM public.email_templates WHERE id = 'hcc_batch_check';
DELETE FROM public.platform_defaults_email_templates WHERE id = 'hcc_batch_check';

-- ---------------------------------------------------------------------
-- 5. Remove the HCC-specific setting.
-- ---------------------------------------------------------------------
DELETE FROM public.settings WHERE key = 'hcc_council_email';
DELETE FROM public.event_settings WHERE key = 'hcc_council_email';
DELETE FROM public.platform_defaults_settings WHERE key = 'hcc_council_email';

-- ---------------------------------------------------------------------
-- 6. Drop 'hcc_council_email' from the public-settings RPC allow-lists.
--    Every other key (including regulatory_authority_name and
--    insurance_minimum_amount) is unchanged.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."rpc_get_public_settings"("p_org_id" text)
RETURNS TABLE("key" text, "value" text)
LANGUAGE "sql" STABLE SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
    SELECT "key", "value"
    FROM "public"."settings"
    WHERE "org_id" = p_org_id
      AND "key" = ANY (ARRAY[
        'stall_cost_food', 'stall_cost_general', 'stall_cost_dev',
        'turnstile_site_key', 'base_url', 'cancel_url', 'portal_url',
        'booking_prefix', 'bucket_name',
        'map_center_lat', 'map_center_lng', 'map_default_zoom',
        'food_bookings_open', 'general_bookings_open',
        'sentry_browser_loader_url',
        'brand_primary_color', 'brand_accent_color',
        'logo_url', 'logo_light_url',
        'org_support_email', 'email_footer_text',
        'regulatory_authority_name', 'insurance_minimum_amount'
      ]::text[]);
$$;

CREATE OR REPLACE FUNCTION "public"."rpc_get_public_event_settings"("p_event_id" text)
RETURNS TABLE("key" text, "value" text)
LANGUAGE "sql" STABLE SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
    SELECT "key", "value"
    FROM "public"."event_settings"
    WHERE "event_id" = p_event_id
      AND "key" = ANY (ARRAY[
        'stall_cost_food', 'stall_cost_general', 'stall_cost_dev',
        'turnstile_site_key', 'base_url', 'cancel_url', 'portal_url',
        'booking_prefix', 'bucket_name',
        'map_center_lat', 'map_center_lng', 'map_default_zoom',
        'food_bookings_open', 'general_bookings_open',
        'sentry_browser_loader_url',
        'brand_primary_color', 'brand_accent_color',
        'logo_url', 'logo_light_url',
        'org_support_email', 'email_footer_text',
        'regulatory_authority_name', 'insurance_minimum_amount'
      ]::text[]);
$$;
