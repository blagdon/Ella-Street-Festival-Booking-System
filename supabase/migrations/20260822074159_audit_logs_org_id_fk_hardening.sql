-- Phase 2D (part 2) — audit_logs.org_id FK.
--
-- audit_logs.org_id previously had no FK to organisations at all. The
-- previously-deferred blocker (two genuine historical production audit
-- records whose organisations had been removed) has been resolved by an
-- explicit decision: all audit history that needs to be retained is already
-- archived elsewhere, so remaining audit_logs rows referencing a deleted
-- organisation are disposable. Those rows (2 on production, plus TEST's own
-- accumulated test-debris orphans) were deleted separately, immediately
-- before this migration, on both projects.
--
-- ON DELETE RESTRICT (not CASCADE, not SET NULL): audit logs should prevent
-- accidental organisation deletion while they remain in the live database.
-- If audit records genuinely need to be removed, they must be deliberately
-- archived/deleted first, not silently discarded as a side effect of
-- deleting the organisation they reference.
--
-- Deliberately NOT touched by this migration: audit_logs.event_id (a
-- separate, still-unresolved design question - see the Phase 2D design
-- audit), the Phase 2C composite FKs, the six Phase 2D Part 1 organisation
-- FKs, booking_locations, performers, schedules, event_settings, RLS,
-- grants, or any application/Edge Function code.
--
-- TEST project only at authoring time (qeplpcnrkgpaawfyliap). Not yet
-- applied to production.

ALTER TABLE "public"."audit_logs"
  ADD CONSTRAINT "audit_logs_org_id_fkey"
  FOREIGN KEY ("org_id")
  REFERENCES "public"."organisations" ("id")
  ON DELETE RESTRICT;
