-- Migration: 20260814150000_multi_event_phase2_isolation_and_default_event.sql
-- Multi-Event Architecture Phase 2 — Event Isolation Correctness &
-- Default-Event Resolution.
--
-- Closes the gaps found in the post-release Phase 1 review and the
-- dedicated Phase 2 architecture investigation:
--
-- 1. Production data correction (explicitly approved): org_default
--    currently has TWO events with is_active=true simultaneously -
--    event_default (status=open) and event_1785595644533/ESF28
--    (status=draft). A per-organisation uniqueness constraint on
--    is_active cannot be added while that conflict exists. Corrects
--    ESF28's is_active to false - it is a draft event, not the
--    operational one - and touches no other row, no other column.
--
-- 2. bookings.event_id / locations.event_id get real foreign keys to
--    events.id (ON DELETE RESTRICT - events are archived, never deleted,
--    per the investigation's finding that no code path ever deletes one;
--    RESTRICT keeps that true at the database level too, not just by
--    convention). Read-only checks against both production and the test
--    project (this session) confirmed zero orphaned/NULL/mismatched
--    event_id values on either table in either environment.
--
-- 3. events.is_default: a new, genuinely distinct concept from is_active
--    (Decision 3) - is_active is "the one event currently treated as
--    operational for authenticated admin/steward auto-resolution";
--    is_default is "the one event used to resolve public/anonymous
--    operations (submit-booking) when no explicit event is specified".
--    Both are now database-enforced unique per organisation via partial
--    unique indexes - "at most one true per org", not application
--    discipline. is_default is additionally lifecycle-gated: a draft or
--    archived event can never be the default (Decision 5), enforced by a
--    same-row CHECK constraint - verified in a rolled-back transaction
--    against the test project during investigation that this has no
--    PostgreSQL semantic awkwardness (single-row rule, no cross-row
--    reference needed).
--
-- 4. rpc_set_active_event(p_event_id) / rpc_set_default_event(p_event_id):
--    atomic promotion RPCs, since a client-side "clear the old one, then
--    set the new one" two-step update would be racy against the new
--    unique indexes (Decision 2/3 explicitly reject that approach). Both
--    resolve their target event's own organisation (never the caller's
--    ambient context) and authorise against THAT organisation via the
--    existing is_authorised_for_org() helper - the same "target row is
--    the protected resource" pattern already used throughout this schema
--    (rpc_set_booking_locations, rpc_record_refund, etc.), which is what
--    makes cross-organisation activation/defaulting structurally
--    impossible rather than merely checked.

-- ---------------------------------------------------------------------
-- 1. Production data correction (explicitly approved) - idempotent,
--    scoped to exactly the one row identified during investigation.
-- ---------------------------------------------------------------------
UPDATE "public"."events" SET "is_active" = false WHERE "id" = 'event_1785595644533';

-- ---------------------------------------------------------------------
-- 2. Referential integrity
-- ---------------------------------------------------------------------
ALTER TABLE "public"."bookings"
    ADD CONSTRAINT "bookings_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events" ("id") ON DELETE RESTRICT;

ALTER TABLE "public"."locations"
    ADD CONSTRAINT "locations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events" ("id") ON DELETE RESTRICT;

-- ---------------------------------------------------------------------
-- 3. events.is_default + uniqueness + lifecycle
-- ---------------------------------------------------------------------
ALTER TABLE "public"."events" ADD COLUMN IF NOT EXISTS "is_default" boolean NOT NULL DEFAULT false;

-- is_active's column default has been `true` since Phase 1's baseline
-- (20260801002_create_events.sql), from when every org had exactly one
-- event and defaulting it active was harmless. Now that is_active is
-- unique per organisation, that default is a landmine: any insert that
-- doesn't think about is_active at all (a test fixture, a future script,
-- a call site nobody has updated yet) would either violate the new
-- constraint outright or silently steal "active" status from whatever
-- else the org already had. Explicit promotion (rpc_set_active_event) is
-- now how an event becomes active - defaulting to inactive is consistent
-- with that, and matches is_default's own default of false.
ALTER TABLE "public"."events" ALTER COLUMN "is_active" SET DEFAULT false;

COMMENT ON COLUMN "public"."events"."is_default" IS
    'The organisation''s designated event for resolving public/anonymous '
    'operations (submit-booking) when no explicit event slug is supplied. '
    'Distinct from is_active (the operational event for authenticated '
    'admin/steward sessions) - Multi-Event Phase 2, Decision 3. At most one '
    'true per organisation (events_org_default_unique); cannot be true for '
    'a draft or archived event (events_default_lifecycle_check).';

CREATE UNIQUE INDEX "events_org_default_unique" ON "public"."events" ("org_id") WHERE "is_default";
CREATE UNIQUE INDEX "events_org_active_unique"  ON "public"."events" ("org_id") WHERE "is_active";

ALTER TABLE "public"."events" ADD CONSTRAINT "events_default_lifecycle_check"
    CHECK (NOT "is_default" OR "status" NOT IN ('draft', 'archived'));

-- ---------------------------------------------------------------------
-- 3b. Backwards-compatible default-event promotion (data-driven, no
--     hardcoded event IDs). Runs AFTER is_default/its unique index/its
--     lifecycle CHECK all exist, and AFTER the ESF28 is_active correction
--     above - so this can only ever select an event that is genuinely
--     eligible, and the constraints themselves would reject any violation
--     of the one-default-per-org invariant rather than this UPDATE
--     silently producing one.
--
-- Without this, every existing organisation's is_default starts false,
-- and org_default's public booking form's no-slug entry point - a real,
-- currently-live feature (js/public-context.js's own comment: "the legacy
-- single-tenant case every booking form supported before Phase 4D") -
-- would break immediately on deployment. Promotes whichever event is
-- currently is_active AND not draft/archived to also be that
-- organisation's default: for org_default this resolves to event_default
-- specifically (the only is_active event left after the ESF28
-- correction), not because its ID is special-cased but because it's the
-- only one that qualifies - the same rule applied generally to every
-- organisation. An organisation whose only event is still draft
-- (avenue1, at the time this migration was written) gets no default,
-- exactly as before: a draft event was never publicly bookable either
-- way, so nothing that used to work stops working.
-- ---------------------------------------------------------------------
UPDATE "public"."events" e
SET "is_default" = true
WHERE e."is_active" = true
  AND e."status" NOT IN ('draft', 'archived')
  AND NOT EXISTS (
      SELECT 1
      FROM "public"."events" e2
      WHERE e2."org_id" = e."org_id"
        AND e2."is_default"
  );

-- ---------------------------------------------------------------------
-- 4. Atomic active/default-event promotion RPCs
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."rpc_set_active_event"("p_event_id" text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_org_id text;
BEGIN
    SELECT org_id INTO v_org_id FROM events WHERE id = p_event_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Event not found';
    END IF;

    -- Authorised against the event's own organisation, not the caller's
    -- current context - the event is the protected resource, same
    -- reasoning as rpc_set_booking_locations.
    IF NOT is_authorised_for_org(v_org_id, ARRAY['admin']) THEN
        RAISE EXCEPTION 'Not authorized: admin role required';
    END IF;

    -- Atomic clear-then-set inside this one function call - a client-side
    -- two-step update would race against events_org_active_unique between
    -- the two statements; this closes that window entirely rather than
    -- accepting it.
    UPDATE events SET is_active = false WHERE org_id = v_org_id AND is_active = true;
    UPDATE events SET is_active = true WHERE id = p_event_id;
END;
$$;

GRANT EXECUTE ON FUNCTION "public"."rpc_set_active_event"(text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."rpc_set_active_event"(text) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."rpc_set_default_event"("p_event_id" text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_org_id text;
    v_status text;
BEGIN
    SELECT org_id, status INTO v_org_id, v_status FROM events WHERE id = p_event_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Event not found';
    END IF;

    IF NOT is_authorised_for_org(v_org_id, ARRAY['admin']) THEN
        RAISE EXCEPTION 'Not authorized: admin role required';
    END IF;

    -- Friendly pre-check ahead of the raw events_default_lifecycle_check
    -- violation - this RPC already has the status in hand, so there is no
    -- need to make the caller parse a constraint name out of a raw
    -- Postgres error the way submitCreateEvent does for booking_prefix.
    IF v_status IN ('draft', 'archived') THEN
        RAISE EXCEPTION 'Cannot set a % event as the organisation''s default - only ready, open, or closed events are eligible.', v_status;
    END IF;

    UPDATE events SET is_default = false WHERE org_id = v_org_id AND is_default = true;
    UPDATE events SET is_default = true WHERE id = p_event_id;
END;
$$;

GRANT EXECUTE ON FUNCTION "public"."rpc_set_default_event"(text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."rpc_set_default_event"(text) TO "service_role";
