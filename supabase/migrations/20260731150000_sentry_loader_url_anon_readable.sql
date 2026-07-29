-- login.html/steward_login.html don't call requireAuth() (there's no
-- session yet at that point - that's the whole point of the login form),
-- so they can't rely on the authenticated-admin settings read every other
-- admin page uses. They need sentry_browser_loader_url readable by anon,
-- the same way turnstile_site_key already is - exactly as safe, since a
-- Sentry loader URL is designed to be embedded in client-visible code, same
-- as a Turnstile site key.
--
-- sentry_dsn (the Edge Function backend DSN) deliberately stays OFF this
-- list - no browser page of any kind needs it, only _shared/sentry.ts via
-- the service-role client, which bypasses RLS entirely.
ALTER POLICY "Allow public anon to read non-sensitive settings" ON "public"."settings"
  USING (("key" = ANY (ARRAY[
    'stall_cost_food'::"text", 'stall_cost_general'::"text", 'stall_cost_dev'::"text",
    'turnstile_site_key'::"text", 'base_url'::"text", 'cancel_url'::"text", 'portal_url'::"text",
    'booking_prefix'::"text", 'bucket_name'::"text", 'hcc_council_email'::"text",
    'map_center_lat'::"text", 'map_center_lng'::"text", 'map_default_zoom'::"text",
    'food_bookings_open'::"text", 'general_bookings_open'::"text",
    'sentry_browser_loader_url'::"text"
  ])));
