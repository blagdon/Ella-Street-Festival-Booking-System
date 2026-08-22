-- Migration: 20260822131723_restore_refund_atomic_claim_guard.sql
--
-- Restores a lost concurrency guard on rpc_record_refund's claiming UPDATE.
--
-- History (verified against the live TEST definition before authoring this,
-- not just inferred from migration files):
--   1. 20260731170000_atomic_refund_claim.sql added
--      "AND refund_amount IS NULL" to the claiming UPDATE's WHERE clause,
--      specifically to close a concurrent double-refund race: two
--      overlapping calls could both read refund_amount = NULL before either
--      committed, and without a re-check inside the UPDATE itself, both
--      would then write, with the second silently overwriting the first.
--   2. 20260801102_migrate_security_rpcs_to_organisation_members.sql
--      (Multi-Tenant Phase 1&2, PR #130) redefined this function to migrate
--      its authorisation check onto organisation_members, and in doing so
--      re-pasted the whole function body from before the guard existed -
--      silently dropping it. Neither that migration's header nor its commit
--      message mentions the guard; nothing suggests this was intentional.
--   3. 20260806030000_decision4_rpc_authorisation_completion.sql and
--      20260807060000_consolidate_rpc_org_role_check.sql (the current live
--      definition) each carried the already-regressed body forward.
--
-- Confirmed live and reproduced, not just inferred: querying
-- pg_get_functiondef against the TEST project confirmed the deployed
-- function's UPDATE has no refund_amount guard, and a manual concurrency
-- probe (independent Supabase client connections, 8-way concurrent
-- rpc_record_refund calls against one freshly-seeded paid booking) produced
-- multiple simultaneous winners in a genuinely concurrent run - i.e. more
-- than one refund recorded against a single booking, which is exactly the
-- corruption this guard exists to prevent. tests/refunds.test.mjs's own
-- "atomic: only one of two concurrent partial refunds wins" test happens to
-- pass reliably today not because the race is closed, but because its two
-- concurrent calls, sharing one client's connection, rarely achieve true
-- overlap - a false negative from timing, not evidence of safety.
--
-- This migration does not touch authorisation, organisation checks,
-- service-role behaviour, actor attribution, or partial-refund semantics -
-- all of that is carried forward unchanged from the current live
-- definition. It restores exactly the one guard that was lost, and
-- distinguishes the "lost the race" case from the pre-existing "booking has
-- no recorded payment" case (the pre-check now also reads payments.paid, so
-- an unpaid booking is still rejected with its original, unchanged message
-- - only a booking that WAS paid and unrefunded at read time, but loses a
-- genuine race before its UPDATE runs, gets the restored message).
--
-- Historical migrations above are left untouched, per this repo's
-- immutable-migration-history convention; this is a new CREATE OR REPLACE,
-- not an edit to any of them.

CREATE OR REPLACE FUNCTION "public"."rpc_record_refund"(
    "p_booking_id" text,
    "p_refund_amount" numeric,
    "p_refund_reference" text,
    "p_notes" text DEFAULT NULL::text,
    "p_refunded_by" text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_admin_email text;
    v_actor text;
    v_booking_org_id text;
    v_stall_cost numeric;
    v_already_refunded numeric;
    v_paid boolean;
BEGIN
    IF auth.uid() IS NOT NULL THEN
        SELECT org_id INTO v_booking_org_id FROM bookings WHERE id = p_booking_id;

        IF NOT is_authorised_for_org(v_booking_org_id, ARRAY['admin']) THEN
            RAISE EXCEPTION 'Not authorized';
        END IF;
        SELECT email INTO v_admin_email FROM user_roles WHERE id = auth.uid();
        IF v_admin_email IS NULL THEN
            SELECT u.email INTO v_admin_email FROM auth.users u WHERE u.id = auth.uid();
        END IF;
        v_actor := COALESCE(v_admin_email, 'Admin');
    ELSE
        v_actor := COALESCE(p_refunded_by, 'system');
    END IF;

    IF p_refund_reference IS NULL OR trim(p_refund_reference) = '' THEN
        RAISE EXCEPTION 'Refund reference is required.';
    END IF;

    IF p_refund_amount IS NULL OR p_refund_amount <= 0 THEN
        RAISE EXCEPTION 'Refund amount must be greater than zero.';
    END IF;

    SELECT b.stall_cost, p.refund_amount, p.paid
      INTO v_stall_cost, v_already_refunded, v_paid
      FROM bookings b
      LEFT JOIN payments p ON p.booking_id = b.id
     WHERE b.id = p_booking_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Booking % not found.', p_booking_id;
    END IF;

    IF v_already_refunded IS NOT NULL THEN
        RAISE EXCEPTION 'Booking % has already been refunded (%). Only one refund per booking is supported.', p_booking_id, v_already_refunded;
    END IF;

    IF NOT COALESCE(v_paid, false) THEN
        RAISE EXCEPTION 'Booking % has no recorded payment to refund.', p_booking_id;
    END IF;

    IF v_stall_cost IS NOT NULL AND p_refund_amount > v_stall_cost THEN
        RAISE EXCEPTION 'Refund amount % exceeds the booking cost %.', p_refund_amount, v_stall_cost;
    END IF;

    -- Atomic claim: re-checks refund_amount IS NULL at UPDATE time, not just
    -- against the SELECT snapshot above, so a second concurrent call that
    -- read the same "not yet refunded" snapshot cannot also win. This is
    -- the guard restored by this migration - see the header above.
    UPDATE payments
    SET refund_amount = p_refund_amount,
        refunded_at = now(),
        refunded_by = v_actor,
        refund_reference = p_refund_reference,
        refund_notes = p_notes,
        updated_at = now()
    WHERE booking_id = p_booking_id AND paid = true AND refund_amount IS NULL;

    IF NOT FOUND THEN
        -- Every precondition above passed against our own snapshot, so
        -- reaching here means a concurrent call refunded this booking
        -- between our SELECT and this UPDATE.
        RAISE EXCEPTION 'Booking % has already been refunded (refunded by a concurrent request). Only one refund per booking is supported.', p_booking_id;
    END IF;
END;
$$;
