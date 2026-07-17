-- ===================================================================
-- REMOVE UNUSED EMAIL RATE LIMIT SETTINGS
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- add_costs_settings.sql inserted 'email_rate_limit' and
-- 'email_rate_window_ms' rows that only fed checkEmailRateLimit() in
-- js/utils.js — a client-side limiter that was never called from any
-- code path. The dead function, its CONFIG plumbing, and the settings
-- UI fields have been removed; real email abuse controls are the
-- admin-role gates and recipient/size caps in the queue-bulk-email and
-- send-email Edge Functions. Removing the orphaned rows so the settings
-- table only holds keys the app actually reads.
-- ===================================================================

DELETE FROM settings WHERE key IN ('email_rate_limit', 'email_rate_window_ms');
