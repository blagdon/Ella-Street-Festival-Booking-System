-- Delivery-status tracking for SMS Works messages.
--
-- Reported live: a bulk send of 3 texts showed all 3 as "Sent" in sms_queue,
-- but only 2 arrived on the handset. Investigation confirmed this was never
-- a queue bug — sms_queue.status only ever meant "did the API call to the
-- provider succeed," never "did the text actually reach the phone." SMS Works
-- can accept a message and still fail to deliver it downstream (bad number
-- reachability, carrier filtering, roaming), and that failure is only
-- visible via a follow-up status check this system never made.
--
-- These three nullable columns store the result of that follow-up check
-- (see checkDeliveryStatus() in _shared/sms.ts and the new check-sms-delivery
-- Edge Function). Deliberately kept SEPARATE from `status`: nothing here
-- changes retry eligibility (retry-queued-sms still only acts on
-- status='Error') — re-submitting a message that was accepted but later
-- reported undeliverable would just pay for and likely repeat the same
-- carrier-side failure. delivery_status is visibility, not a retry trigger.
--
-- delivery_status stores the raw string SMS Works returns, verbatim. Their
-- OpenAPI spec does not constrain/enumerate this field (confirmed against
-- their own SDK docs — only one value, EXPIRED, could be confirmed from a
-- primary source), so this deliberately does NOT validate against a
-- hardcoded list. Any UI coloring is a best-effort heuristic on the raw
-- string, not a switch on known values.
--
-- delivery_failure_reason stores the whole {code, details, permanent} object
-- SMS Works returns on failure, as jsonb rather than separate columns, so any
-- field they add later is captured without another migration.
--
-- Additive/nullable-safe, same shape as 20260719120000_email_queue_retry_tracking.sql —
-- no grant changes needed, new columns inherit sms_queue's existing grants
-- (authenticated: SELECT+INSERT only, no UPDATE — status transitions stay
-- service-role/RPC-only, which is why checking delivery needs an Edge
-- Function rather than a direct client update, same reason retry does).

ALTER TABLE "public"."sms_queue"
  ADD COLUMN IF NOT EXISTS "delivery_status" "text",
  ADD COLUMN IF NOT EXISTS "delivery_checked_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "delivery_failure_reason" "jsonb";

COMMENT ON COLUMN "public"."sms_queue"."delivery_status" IS
  'Raw status string from The SMS Works'' GET /messages/{messageid}, stored verbatim (their API does not enumerate this field). Null until an admin checks. Independent of `status`, which only reflects whether the send API call itself succeeded.';
COMMENT ON COLUMN "public"."sms_queue"."delivery_checked_at" IS
  'When delivery status was last checked (null if never checked).';
COMMENT ON COLUMN "public"."sms_queue"."delivery_failure_reason" IS
  'The {code, details, permanent} object SMS Works returns when delivery failed, stored as-is. Null when not applicable or not yet checked.';
