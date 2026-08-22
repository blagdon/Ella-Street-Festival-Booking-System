-- Phase 2D (part 1) — organisation-scope FK hardening for six clean tables.
--
-- The Phase 2D read-only design audit established that payments, sms_queue,
-- email_queue, settings, email_templates, and sms_templates all carry a
-- NOT NULL org_id column with NO foreign key to organisations at all — the
-- relationship has only ever been maintained by application discipline (RLS,
-- RPC-internal derivation from a trusted resource, or organisation_members
-- membership checks), never enforced by the database itself. The write-path
-- audit confirmed every real, currently-reachable application write path
-- already supplies a genuinely valid org_id for all six tables; the TEST
-- orphans that existed (1 email_queue row, plus incidental audit_logs debris
-- unrelated to these six tables) were produced only by raw service-role test
-- cleanup bypassing the application entirely, not by any live write path,
-- and have been remediated separately before this migration was authored.
--
-- audit_logs.org_id and audit_logs.event_id are DELIBERATELY NOT included
-- here. Production contains two genuine historical audit records
-- (org_id 'ella-cert-qa-aug26' and 'round3-cert-aug26') whose organisations
-- were later removed — real certification-era admin activity, not test
-- debris. Constraining audit_logs.org_id today would require deciding how
-- audit history should behave when an organisation is deleted, which is an
-- explicit, separate, not-yet-made design decision. See HANDOVER/DECISIONS
-- for the eventual writeup once that decision is made. Do not add this FK
-- without revisiting that decision first.
--
-- ON DELETE semantics, per organisation type:
--   - payments, sms_queue, email_queue: RESTRICT. These are operational
--     records (money moved, messages sent) — losing them silently to a
--     cascading organisation delete would be a real data-loss risk, exactly
--     the same reasoning already applied to bookings/locations in Phase 2C.
--   - settings, email_templates, sms_templates: CASCADE. These are the
--     organisation's own configuration, not operational history — an
--     organisation ceasing to exist should reasonably take its own
--     unconfigured/half-configured settings and templates with it, rather
--     than leaving orphaned configuration rows behind with nothing left to
--     apply them to.
--
-- Verified against the only organisation-deletion code path that exists
-- anywhere in this application (provision-organisation's own
-- rollback-on-failure block): it never encounters a payments/sms_queue/
-- email_queue row referencing the organisation it deletes (those tables are
-- never written during provisioning), and already deletes settings/
-- email_templates/sms_templates explicitly before deleting the organisation
-- itself — so CASCADE here changes nothing about that flow's own behaviour,
-- it only adds a backstop the explicit deletes were already providing.
--
-- Deliberately NOT touched by this migration: audit_logs (either column),
-- booking_locations, locations identity, event_settings, performers,
-- schedules, RLS policies, grants, or any application/Edge Function code.
--
-- TEST project only at authoring time (qeplpcnrkgpaawfyliap). Not yet
-- applied to production.

ALTER TABLE "public"."payments"
  ADD CONSTRAINT "payments_org_id_fkey"
  FOREIGN KEY ("org_id")
  REFERENCES "public"."organisations" ("id")
  ON DELETE RESTRICT;

ALTER TABLE "public"."sms_queue"
  ADD CONSTRAINT "sms_queue_org_id_fkey"
  FOREIGN KEY ("org_id")
  REFERENCES "public"."organisations" ("id")
  ON DELETE RESTRICT;

ALTER TABLE "public"."email_queue"
  ADD CONSTRAINT "email_queue_org_id_fkey"
  FOREIGN KEY ("org_id")
  REFERENCES "public"."organisations" ("id")
  ON DELETE RESTRICT;

ALTER TABLE "public"."settings"
  ADD CONSTRAINT "settings_org_id_fkey"
  FOREIGN KEY ("org_id")
  REFERENCES "public"."organisations" ("id")
  ON DELETE CASCADE;

ALTER TABLE "public"."email_templates"
  ADD CONSTRAINT "email_templates_org_id_fkey"
  FOREIGN KEY ("org_id")
  REFERENCES "public"."organisations" ("id")
  ON DELETE CASCADE;

ALTER TABLE "public"."sms_templates"
  ADD CONSTRAINT "sms_templates_org_id_fkey"
  FOREIGN KEY ("org_id")
  REFERENCES "public"."organisations" ("id")
  ON DELETE CASCADE;
