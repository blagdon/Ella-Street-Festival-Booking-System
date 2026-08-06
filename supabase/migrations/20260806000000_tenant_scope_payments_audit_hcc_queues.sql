-- Migration: 20260806000000_tenant_scope_payments_audit_hcc_queues.sql
-- Found by sweeping for every other instance of the pattern Finding 1 (in
-- 20260805040000) fixed for bookings/locations/events/booking_locations/
-- email_templates/sms_templates, per CLAUDE.md's "sweep for every instance
-- of a pattern before calling a fix done" rule — the Launch Readiness
-- Review's own live RLS introspection named those six tables by number, but
-- didn't check every table with an org_id column against every Edge
-- Function's own insert statements. Five more tables have the identical
-- gap: payments, audit_logs, hcc_checks, email_queue, sms_queue all still
-- gate ALL/SELECT purely on check_user_role('admin') with no correlation to
-- the row's own org_id — any organisation's admin can already read or write
-- every other organisation's payment records, audit trail, HCC check
-- status, and message queues.
--
-- This is compounded by a second, independent bug found while checking
-- these tables' actual data: org_id on all five is NOT NULL DEFAULT
-- 'org_default', and every write site across the whole codebase except
-- rpc_record_bank_transfer_payment, queue-bulk-email/sms, and js/audit.js's
-- auditLog() helper omitted org_id entirely — the exact same "silently
-- defaults to org_default regardless of the real organisation" shape as the
-- js/settings/*.js bug fixed in the RC Operational Certification (#165).
-- Tightening RLS without first fixing this would have hidden an org's own
-- real rows from itself, not just closed the cross-tenant leak, so both are
-- fixed together here. finalize_stripe_payment (the Stripe auto-confirm
-- path) is the one payments write site with no caller session to draw
-- org_id from at all — it now captures it from the booking being confirmed,
-- in the same statement. Every email_queue/sms_queue/hcc_checks/audit_logs
-- insert site fixed at the call site (js/api.js, submit-booking,
-- cancel-booking, create-checkout-session, stripe-webhook, send-sms) — see
-- that PR's diff, not repeated here since this migration only covers the
-- database side.
--
-- All five Edge Functions and js/api.js's own authenticated writes already
-- use either the service-role key (bypasses RLS entirely — every
-- transactional email/SMS/audit insert above) or pass an org_id the caller
-- is genuinely an admin of (js/audit.js's auditLog(), js/api.js's
-- sendEmailDirect/updateBookingStatus) — confirmed by reading every one of
-- these files' client construction before tightening WITH CHECK, not
-- assumed.

-- ---------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."finalize_stripe_payment"(
    "p_booking_id" "text",
    "p_payment_intent_id" "text"
) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_org_id text;
BEGIN
    UPDATE bookings
    SET status = 'Confirmed',
        stripe_payment_intent_id = p_payment_intent_id,
        date_confirmed = now()
    WHERE id = p_booking_id AND status = 'Payment Requested'
    RETURNING org_id INTO v_org_id;

    IF FOUND THEN
        INSERT INTO payments (booking_id, paid, date_paid, bank_ref, editor, payment_method, org_id)
        VALUES (p_booking_id, true, CURRENT_DATE, 'Stripe: ' || p_payment_intent_id, 'Stripe (automatic)', 'stripe', v_org_id)
        ON CONFLICT (booking_id) DO UPDATE
        SET paid = true,
            date_paid = CURRENT_DATE,
            bank_ref = EXCLUDED.bank_ref,
            editor = EXCLUDED.editor,
            payment_method = 'stripe',
            updated_at = now();
    END IF;
END;
$$;

DROP POLICY IF EXISTS "Admin only payments" ON "public"."payments";

CREATE POLICY "Admins can manage own org payments" ON "public"."payments"
    FOR ALL TO "authenticated"
    USING ("public"."is_platform_admin"() OR "public"."has_org_role"("payments"."org_id", ARRAY['admin']))
    WITH CHECK ("public"."is_platform_admin"() OR "public"."has_org_role"("payments"."org_id", ARRAY['admin']));

-- ---------------------------------------------------------------------
-- audit_logs (SELECT side only — the proven leak. INSERT stays
-- WITH CHECK (true): every real writer already supplies a correct org_id
-- (js/audit.js's auditLog(), or a service-role Edge Function insert that
-- bypasses RLS regardless), so tightening it here would add a check nothing
-- currently needs while risking a future legitimate cross-org audit write,
-- e.g. a platform admin action logged against the org being acted on rather
-- than the admin's own org_default membership.)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Admin view audit" ON "public"."audit_logs";

CREATE POLICY "Admins can view own org audit_logs" ON "public"."audit_logs"
    FOR SELECT TO "authenticated"
    USING ("public"."is_platform_admin"() OR "public"."has_org_role"("audit_logs"."org_id", ARRAY['admin']));

-- ---------------------------------------------------------------------
-- hcc_checks
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins manage hcc_checks" ON "public"."hcc_checks";

CREATE POLICY "Admins can manage own org hcc_checks" ON "public"."hcc_checks"
    FOR ALL TO "authenticated"
    USING ("public"."is_platform_admin"() OR "public"."has_org_role"("hcc_checks"."org_id", ARRAY['admin']))
    WITH CHECK ("public"."is_platform_admin"() OR "public"."has_org_role"("hcc_checks"."org_id", ARRAY['admin']));

-- ---------------------------------------------------------------------
-- email_queue
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Admin manage email" ON "public"."email_queue";

CREATE POLICY "Admins can manage own org email_queue" ON "public"."email_queue"
    FOR ALL TO "authenticated"
    USING ("public"."is_platform_admin"() OR "public"."has_org_role"("email_queue"."org_id", ARRAY['admin']))
    WITH CHECK ("public"."is_platform_admin"() OR "public"."has_org_role"("email_queue"."org_id", ARRAY['admin']));

-- ---------------------------------------------------------------------
-- sms_queue
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Admin manage sms" ON "public"."sms_queue";

CREATE POLICY "Admins can manage own org sms_queue" ON "public"."sms_queue"
    FOR ALL TO "authenticated"
    USING ("public"."is_platform_admin"() OR "public"."has_org_role"("sms_queue"."org_id", ARRAY['admin']))
    WITH CHECK ("public"."is_platform_admin"() OR "public"."has_org_role"("sms_queue"."org_id", ARRAY['admin']));
