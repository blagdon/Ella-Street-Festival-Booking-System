-- Migration: 20260804120000_grant_event_settings_delete.sql
-- Epic 4, Phase 4B.1 — fixes a real gap found while writing
-- tests/phase4b-event-configuration.test.mjs.
--
-- 20260804110000_create_event_settings.sql granted authenticated users
-- SELECT, INSERT, UPDATE — copied verbatim from the settings table's own
-- grants, which have never needed DELETE because nothing ever deletes a
-- settings row. event_settings is different: "Reset to Organisation
-- Default" (js/settings/event-config.js) deletes the override row rather
-- than copying the organisation value over it, by design. The RLS policy
-- already covers DELETE (FOR ALL, no FOR clause), but Postgres enforces the
-- coarser table-level GRANT first — without it, every admin's Reset click
-- would fail with "permission denied for table event_settings" before RLS
-- is ever evaluated.

GRANT DELETE ON TABLE "public"."event_settings" TO "authenticated";
