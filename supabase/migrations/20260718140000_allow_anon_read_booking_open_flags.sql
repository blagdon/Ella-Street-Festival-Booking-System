-- The public booking pages decide whether to show the "bookings closed"
-- notice by reading settings.food_bookings_open / general_bookings_open as
-- anon (js/page-food-booking.js, js/page-general-booking.js). But the anon
-- SELECT policy's key allowlist never included those two keys, so RLS
-- filtered the row out, .single() errored on zero rows, the page's catch
-- swallowed it as a console.warn, and the form stayed open regardless of the
-- admin toggle in settings.html (js/page-settings.js toggleSetting). The
-- "Closed (Visitors Blocked)" switch has therefore never actually blocked
-- visitors.
--
-- Fix: add the two keys to the allowlist. Both hold only the strings
-- 'true'/'false' written by toggleSetting - nothing sensitive. Everything
-- else about the policy (SELECT-only, TO anon) is unchanged, and the
-- table-level grant narrowing from 20260717100000 (anon: SELECT only) stays
-- as the independent second layer. Postgres has no CREATE OR REPLACE POLICY,
-- so drop and recreate; db push wraps the migration in one transaction, so
-- there is no window where anon reads nothing.

DROP POLICY "Allow public anon to read non-sensitive settings" ON "public"."settings";

CREATE POLICY "Allow public anon to read non-sensitive settings" ON "public"."settings" FOR SELECT TO "anon" USING (("key" = ANY (ARRAY['stall_cost_food'::"text", 'stall_cost_general'::"text", 'stall_cost_dev'::"text", 'turnstile_site_key'::"text", 'base_url'::"text", 'cancel_url'::"text", 'portal_url'::"text", 'booking_prefix'::"text", 'bucket_name'::"text", 'hcc_council_email'::"text", 'map_center_lat'::"text", 'map_center_lng'::"text", 'map_default_zoom'::"text", 'food_bookings_open'::"text", 'general_bookings_open'::"text"])));
