-- Retry tracking for failed email sends, backing the Email Queue viewer's
-- new "Retry" action (retry-queued-email Edge Function).
--
-- email_queue.html has surfaced failed sends (status='Error') with their Zoho
-- error message since v5.1.0, but an admin who saw a failure had no way to act
-- on it — the only recovery was re-triggering the original action from the
-- booking, which isn't possible for every email type. These two columns record
-- how many times a row has been retried and when, so the viewer can show
-- "retried 2x" rather than looking identical to a never-retried failure.
--
-- Deliberately additive/nullable-safe: existing rows get retry_count=0, which
-- is exactly right (they've never been retried). No grant changes — column
-- additions inherit the table's existing grants, and authenticated keeps
-- SELECT+INSERT only (the retry itself runs service-role inside the Edge
-- Function, since authenticated has no UPDATE on this table by design —
-- see 20260718110000_narrow_authenticated_table_grants.sql).

ALTER TABLE "public"."email_queue"
  ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_retry_at" timestamp with time zone;

COMMENT ON COLUMN "public"."email_queue"."retry_count" IS
  'Number of times an admin has manually retried this send via the Email Queue viewer. 0 = never retried.';
COMMENT ON COLUMN "public"."email_queue"."last_retry_at" IS
  'When the most recent manual retry was attempted (null if never retried).';
