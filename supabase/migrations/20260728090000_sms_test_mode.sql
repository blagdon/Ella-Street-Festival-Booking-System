-- Test Mode for SMS, ahead of wiring up a real provider (The SMS Works).
--
-- Seeded to 'true' (ON) — the same "safe by default" posture the original
-- SMS migration took with sms_provider defaulting to 'mock'. Now that a real
-- account exists, sms_provider can be pointed at 'thesmsworks' with live
-- credentials while this stays a separate, more visible master switch: an
-- admin should not have to remember "sms_provider must say mock" to avoid
-- sending real texts — they flip one obvious toggle in Settings instead.
--
-- Read by _shared/sms.ts's sendViaSms(): when true, the configured provider
-- is bypassed entirely and every send routes through the mock adapter
-- regardless of sms_provider's value, so a send is never a genuine outbound
-- text while this is on. See that file for the exact mechanism.
--
-- ON CONFLICT DO NOTHING so re-running never overwrites an admin's own
-- choice once they've flipped this from the Settings page.

INSERT INTO "public"."settings" ("key", "value", "updated_by") VALUES
  ('sms_test_mode', 'true', 'migration_20260728090000')
ON CONFLICT ("key") DO NOTHING;
