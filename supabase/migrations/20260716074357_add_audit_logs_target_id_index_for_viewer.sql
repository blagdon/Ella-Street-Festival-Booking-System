-- Re-adds idx_audit_logs_target_id, dropped earlier the same day in
-- 20260716060029_drop_unused_indexes.sql on the grounds that no admin page
-- read audit_logs back out at all. That's no longer true: audit_log.html
-- (the new audit-log viewer, built in response to a recovery-testing
-- review) filters by target_id as its primary lookup - "what happened to
-- booking X" - so the index is genuinely used again.
CREATE INDEX IF NOT EXISTS "idx_audit_logs_target_id" ON "public"."audit_logs" USING "btree" ("target_id");
