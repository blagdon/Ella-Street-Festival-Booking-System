-- Migration: 20260814100000_event_scoped_misc_id_and_prefix_uniqueness.sql
-- Multi-Event Architecture Phase 1 — closes two concrete defects found while
-- verifying whether an organisation can safely have multiple events, found
-- to already be true in production: org_default currently has two events
-- (event_default/ESF26, open, and a second event/ESF28, draft).
--
-- Defect 1: rpc_get_next_misc_id() read its booking prefix from
-- organisation-level settings (settings.booking_prefix), not the specific
-- event a MISC booking is actually being added under. A second event of the
-- same org with its own distinct events.booking_prefix would still generate
-- MISC ids under the FIRST event's/org-level prefix. submit-booking's own
-- resolvePublicBookingContext() already resolves the correct per-event
-- prefix for ordinary bookings (events.booking_prefix) - this brings the
-- misc-booking path in line with that, not a new pattern.
--
-- Defect 2: events.booking_prefix had no uniqueness constraint at all.
-- Provisioning checks global uniqueness manually
-- (provision-organisation/index.ts), but manually creating a second event
-- for an existing organisation (js/page-admin.js's submitCreateEvent) never
-- validated this. Both get_next_booking_id() and rpc_get_next_misc_id()'s
-- own max-id scan match `id LIKE prefix || '%'` across the ENTIRE bookings
-- table with no org_id/event_id filter - correctness has always implicitly
-- depended on prefix uniqueness holding globally, just never enforced.
-- Uniqueness is deliberately GLOBAL, not per-organisation, matching that
-- existing global-scan behaviour, and deliberately NOT relaxed for
-- closed/archived events - a retired event's old bookings remain in the
-- same globally-scanned table, so its prefix must not become reusable.
--
-- Verified against production before writing this migration: booking_prefix
-- values currently in use are AF27, ESF26, ESF28, S1SM - all distinct, so
-- this constraint applies cleanly with zero existing conflicts.
--
-- Changing the signature (adding a parameter) doesn't replace the old
-- overload in place - CREATE OR REPLACE only matches on identical argument
-- types, so the original rpc_get_next_misc_id() would otherwise keep
-- existing alongside this one. Drop it explicitly first - same pattern
-- already used in 20260805030000_provision_display_name_override.sql and
-- 20260813140000_e5_23_explicit_org_invite_membership.sql.
--
-- get_current_event_id(), get_current_org_id(), is_authorised_for_org(),
-- and every RLS policy are unchanged by this migration - the existing
-- authorisation model (is_authorised_for_org(get_current_org_id(), admin))
-- is preserved exactly; only the prefix SOURCE and an explicit
-- event-belongs-to-caller's-org check are added.

DROP FUNCTION IF EXISTS "public"."rpc_get_next_misc_id"();

CREATE OR REPLACE FUNCTION "public"."rpc_get_next_misc_id"("p_event_id" text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org_id text;
  v_event_prefix text;
  v_prefix TEXT;
  v_max_num INT;
  v_new_id  TEXT;
BEGIN
  v_org_id := get_current_org_id();

  -- Authorised against the caller's own current org, unchanged from before -
  -- this RPC has no separate protected entity beyond "am I an admin of my
  -- own org" (the target org, like the booking-prefix lookup itself, was
  -- always ambient here, not caller-supplied).
  IF NOT is_authorised_for_org(v_org_id, ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized: admin role required';
  END IF;

  IF p_event_id IS NULL OR trim(p_event_id) = '' THEN
    RAISE EXCEPTION 'Event ID is required';
  END IF;

  -- The event must genuinely belong to the caller's own org - never trust
  -- a client-supplied event id on its own, even from an otherwise-authorised
  -- admin, since nothing else here re-derives org_id from p_event_id.
  SELECT booking_prefix INTO v_event_prefix
  FROM events
  WHERE id = p_event_id AND org_id = v_org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event does not belong to the caller''s organisation';
  END IF;

  LOCK TABLE bookings IN SHARE ROW EXCLUSIVE MODE;

  v_prefix := COALESCE(v_event_prefix, 'ESF26') || '-MISC-';

  SELECT COALESCE(
    MAX(CAST(SPLIT_PART(id, v_prefix, 2) AS INT)),
    0
  )
  INTO v_max_num
  FROM bookings
  WHERE id LIKE v_prefix || '%'
    AND id ~ ('^' || v_prefix || '\d+$');

  v_new_id := v_prefix || LPAD((v_max_num + 1)::TEXT, 4, '0');

  RETURN v_new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION "public"."rpc_get_next_misc_id"(text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."rpc_get_next_misc_id"(text) TO "service_role";

-- events.booking_prefix uniqueness - global, not scoped by organisation or
-- status (see header comment). ALTER TABLE ... ADD CONSTRAINT fails loudly
-- with a real error if any existing row already violates it, rather than
-- silently succeeding on bad data - confirmed clean against production
-- before this migration was written, not assumed.
ALTER TABLE "public"."events"
    ADD CONSTRAINT "events_booking_prefix_unique" UNIQUE ("booking_prefix");
