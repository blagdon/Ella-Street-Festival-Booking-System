-- Phase 2 tenant-scope DEFAULT audit — comment refresh only.
--
-- Every org_id/event_id column below still carries its original "Phase 1:
-- always org_default/event_default" comment from
-- 20260801004_add_tenant_columns_to_domain_tables.sql /
-- 20260801005_settings_composite_pk.sql. That framing is now stale: RLS has
-- been active on every one of these tables for weeks (confirmed live via
-- pg_policies), and every current INSERT path already supplies the value
-- explicitly (see the Phase 2 tenant-scope DEFAULT audit for the full
-- table-by-table trace). settings.org_id's comment is the most actively
-- misleading instance — it tells the reader not to add an org_id filter
-- "until RLS isolation is active", which has already happened elsewhere in
-- the codebase without this comment being updated to match.
--
-- This migration ONLY updates comments (pg_description metadata) — no
-- column, default, constraint, or index changes. The DEFAULT itself is
-- deliberately NOT touched here: it is still live in the schema, so the new
-- comment text describes it as "still present, no longer relied upon" -
-- not yet removed. That is separate, later Phase 2B/2C work.
--
-- NOT APPLIED to any project as part of Phase 2A preparation — this file
-- exists in the repository for review only, per Phase 2A's read-only/
-- prepare-only scope. It is safe to apply on its own (independent of the
-- DROP DEFAULT work) whenever that's decided, since it changes no runtime
-- behaviour.

COMMENT ON COLUMN "public"."bookings"."org_id" IS
    'Organisation (tenant) scope, RLS-enforced (has_org_role(org_id, ...) on every policy). '
    'DEFAULT ''org_default'' still exists on this column but is a historical Phase 1 '
    'migration artefact, not something any current insert path relies on — submit-booking, '
    'insertMiscBooking(), and every admin/steward write path already set this explicitly. '
    'Do not add new code that omits it and depends on the default.';

COMMENT ON COLUMN "public"."bookings"."event_id" IS
    'Event scope, RLS-enforced, FK to events.id (ON DELETE RESTRICT). '
    'DEFAULT ''event_default'' still exists on this column but is a historical Phase 1 '
    'migration artefact — every current insert path sets this explicitly. Not '
    'DB-enforced to match bookings.org_id (a booking''s event and its own org_id can '
    'currently diverge with nothing to stop it) — see the Phase 2 investigation''s '
    'composite-FK recommendation for that separate, deferred piece of work.';

COMMENT ON COLUMN "public"."locations"."org_id" IS
    'Organisation (tenant) scope, RLS-enforced. DEFAULT ''org_default'' still exists on '
    'this column but is a historical Phase 1 migration artefact — every current admin '
    'CRUD path (page-admin-locations.js) sets this explicitly via getPlatformContext().';

COMMENT ON COLUMN "public"."locations"."event_id" IS
    'Event scope, RLS-enforced, FK to events.id (ON DELETE RESTRICT). '
    'DEFAULT ''event_default'' still exists on this column but is a historical Phase 1 '
    'migration artefact — every current admin CRUD path sets this explicitly. Same '
    'org/event-consistency caveat as bookings.event_id: not DB-enforced against this '
    'row''s own org_id.';

COMMENT ON COLUMN "public"."payments"."org_id" IS
    'Organisation scope, RLS-enforced. Must mirror bookings.org_id for the related '
    'booking — never set this independently. Every live insert path '
    '(finalize_stripe_payment, rpc_record_bank_transfer_payment) already re-derives it '
    'from the parent booking in the same statement. DEFAULT ''org_default'' still exists '
    'on this column but is a historical Phase 1 migration artefact.';

COMMENT ON COLUMN "public"."audit_logs"."org_id" IS
    'Organisation scope for the audit trail, RLS-enforced (is_authorised_for_org). '
    'DEFAULT ''org_default'' still exists on this column but is a historical Phase 1 '
    'migration artefact — the centralising js/audit.js auditLog() helper''s own default '
    'parameters (getCurrentOrgId()) make the column default structurally unreachable '
    'from the browser app; every Edge Function insert site derives it from the booking '
    'row explicitly.';

COMMENT ON COLUMN "public"."audit_logs"."event_id" IS
    'Event scope for the audit trail. DEFAULT ''event_default'' still exists on this '
    'column but is a historical Phase 1 migration artefact — the same auditLog() '
    'helper covers this column too. One historical gap (create-checkout-session''s '
    'sms_sent mirror omitting this column) was found and fixed — see PR #224.';

COMMENT ON COLUMN "public"."email_queue"."org_id" IS
    'Organisation scope, RLS-enforced. DEFAULT ''org_default'' still exists on this '
    'column but is a historical Phase 1 migration artefact — every live insert path '
    'derives it from the resolved booking/caller context, never omits it.';

COMMENT ON COLUMN "public"."sms_queue"."org_id" IS
    'Organisation scope, RLS-enforced. DEFAULT ''org_default'' still exists on this '
    'column but is a historical Phase 1 migration artefact — every live insert path '
    'derives it from the resolved booking/caller context, never omits it.';

COMMENT ON COLUMN "public"."email_templates"."org_id" IS
    'Organisation scope, RLS-enforced, composite primary key member (org_id, id) — see '
    'DECISIONS.md decision 14. DEFAULT ''org_default'' still exists on this column but '
    'is a historical Phase 1 migration artefact — rpc_initialise_tenant_defaults and '
    'every admin save path set this explicitly.';

COMMENT ON COLUMN "public"."sms_templates"."org_id" IS
    'Organisation scope, RLS-enforced, composite primary key member (org_id, id) — see '
    'DECISIONS.md decision 14. DEFAULT ''org_default'' still exists on this column but '
    'is a historical Phase 1 migration artefact — rpc_initialise_tenant_defaults and '
    'every admin save path set this explicitly.';

COMMENT ON COLUMN "public"."settings"."org_id" IS
    'Organisation (tenant) scope, RLS-enforced (organisation_members-joined policies), '
    'composite primary key member (org_id, key). RLS isolation IS active — the earlier '
    'version of this comment telling readers to wait for it before filtering was stale '
    'and has been corrected. DEFAULT ''org_default'' still exists on this column but is '
    'a historical Phase 1 migration artefact — every admin save path and '
    'rpc_initialise_tenant_defaults already set this explicitly.';

COMMENT ON COLUMN "public"."event_settings"."event_id" IS
    'Event scope, RLS-enforced (joined through events.org_id), composite primary key '
    'member (event_id, key). Not every settings key is expected to have an event row — '
    'only keys the admin UI exposes for per-event editing will ever be written here. '
    'DEFAULT ''event_default'' still exists on this column but is a historical Phase 1 '
    'migration artefact; every current insert path (event-config.js) sets this '
    'explicitly. Separately (not related to the default): no code path currently seeds '
    'an event_settings row during organisation/event provisioning at all — see the '
    'Phase 2 investigation for that distinct, deferred gap.';
