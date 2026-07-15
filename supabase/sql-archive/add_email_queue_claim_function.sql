-- ===================================================================
-- FIX: bulk-email reliability — queue server-side first, drain
-- independently of the admin's browser tab
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- Previously, "Email All Confirmed" ran a sequential client-side loop
-- across every confirmed booking, one HTTP request at a time, entirely
-- driven by the admin's open browser tab. Closing the tab mid-send
-- silently abandoned every remaining recipient with no record, no
-- error, and no way to tell who was missed.
--
-- The new queue-bulk-email Edge Function inserts every recipient into
-- email_queue as 'Pending' in one fast atomic write (durable the
-- instant the request lands, regardless of what the browser does
-- next), then drains the queue itself in the background via
-- EdgeRuntime.waitUntil() — independent of the client connection.
--
-- claim_pending_emails() atomically marks a batch as 'Processing' via
-- FOR UPDATE SKIP LOCKED so two overlapping invocations (e.g. a retry
-- after a crash) can't pick up and double-send the same row.
-- ===================================================================

CREATE OR REPLACE FUNCTION public.claim_pending_emails(p_batch_size int DEFAULT 50)
 RETURNS SETOF public.email_queue
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
  UPDATE public.email_queue
  SET status = 'Processing'
  WHERE id IN (
    SELECT id FROM public.email_queue
    WHERE status = 'Pending'
    ORDER BY created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;

REVOKE ALL ON FUNCTION public.claim_pending_emails(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_pending_emails(int) TO service_role;

-- ===================================================================
-- VERIFY:
--   SELECT proname, proconfig FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace AND proname = 'claim_pending_emails';
-- ===================================================================
