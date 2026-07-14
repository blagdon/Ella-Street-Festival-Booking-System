-- ===================================================================
-- FIX: make claim_pending_emails() self-healing, and lock down its grants
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- PART 1 — self-healing stale Processing rows
-- If queue-bulk-email's background drain task ever dies mid-batch
-- (Edge Function execution limit hit, an uncaught exception, the
-- platform tearing down the isolate) a row can be left permanently
-- stuck at status='Processing' with nothing to ever pick it back up,
-- since claim_pending_emails() only ever looks for status='Pending'.
--
-- A naive fix would reclaim any 'Processing' row whose created_at is
-- older than N minutes — but email_queue.created_at is set once, at
-- insert time, not at claim time. queue-bulk-email inserts an entire
-- bulk send's rows in one INSERT, then drains them sequentially with a
-- deliberate pacing delay (MAX_RECIPIENTS=2000, ~100ms+ per row plus
-- real Zoho latency) — a large, entirely healthy send can take well
-- over 15 minutes to drain, so rows near the end of the batch would
-- already look "stale" by created_at while still being legitimately
-- processed by the original still-running invocation. Reclaiming them
-- based on created_at would let a second overlapping bulk-send action
-- re-claim and re-send those same rows — a live duplicate-send bug,
-- worse than the stuck-row problem being fixed.
--
-- Fixed correctly by adding claimed_at (set only when a row actually
-- transitions to Processing) and keying the staleness check off that
-- instead of created_at.
--
-- PART 2 — grants
-- claim_pending_emails() is SECURITY DEFINER and RETURNS SETOF
-- email_queue (RETURNING *) — full recipient/subject/body content of
-- whatever it claims. It currently grants EXECUTE to anon and
-- authenticated in addition to service_role, meaning any caller
-- (including a fully unauthenticated one, via the public anon key)
-- could call it directly: reading queued email content mid-send, and
-- marking those rows Processing without ever completing the send,
-- permanently stranding them (the real drain loop only looks for
-- Pending). Only the service role (used internally by
-- queue-bulk-email) should ever call this. Locked down to match.
-- ===================================================================

ALTER TABLE public.email_queue ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE OR REPLACE FUNCTION public.claim_pending_emails(p_batch_size int DEFAULT 50)
 RETURNS SETOF public.email_queue
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
  UPDATE public.email_queue
  SET status = 'Processing', claimed_at = now()
  WHERE id IN (
    SELECT id FROM public.email_queue
    WHERE status = 'Pending'
       OR (status = 'Processing' AND claimed_at < now() - INTERVAL '15 minutes')
    ORDER BY created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;

REVOKE ALL ON FUNCTION public.claim_pending_emails(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_emails(int) TO service_role;

-- ===================================================================
-- VERIFY:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'email_queue' AND column_name = 'claimed_at';
--   -- should return 1 row.
--
--   SELECT proname, prosrc FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace AND proname = 'claim_pending_emails';
--   -- body should reference claimed_at, not just created_at, in the Processing branch.
--
--   SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public' AND routine_name = 'claim_pending_emails';
--   -- should show only service_role.
-- ===================================================================
