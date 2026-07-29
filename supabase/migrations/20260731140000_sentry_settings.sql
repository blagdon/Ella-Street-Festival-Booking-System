-- Moves Sentry configuration out of hardcoded values and into the settings
-- table, matching how every other integration (Stripe, Zoho, The SMS Works)
-- already works: admin-editable via settings.html, no redeploy needed to
-- rotate or reconfigure.
--
-- Two keys, because there are genuinely two different consumers with
-- different lifecycles:
--
-- - sentry_dsn: read by every Edge Function (_shared/sentry.ts), replacing
--   the SENTRY_DSN Supabase secret. Read via the service-role client, which
--   bypasses RLS entirely - like the Stripe secret keys, this never needs to
--   be in the anon-readable allow-list.
--
-- - sentry_browser_loader_url: the full Sentry Loader Script URL (e.g.
--   https://js-de.sentry-cdn.com/<id>.min.js) for the admin dashboard,
--   replacing the hardcoded <script src> tag previously duplicated across
--   20 HTML files. Read by an authenticated admin session, which already has
--   full settings-table access via the "Admin full access to settings" RLS
--   policy - also doesn't need the anon allow-list, since no public
--   (unauthenticated) page uses this.
--
-- Neither value is a secret in the way a Stripe secret key is - Sentry DSNs
-- and loader URLs are meant to be embedded in client-visible code - so
-- neither needs write-only masking in the settings UI, unlike the Stripe/
-- SMS Works API key fields.
--
-- Empty by default: Sentry monitoring already fails safe when unconfigured
-- (_shared/sentry.ts's captureAndFlush() no-ops cleanly with no DSN; the
-- browser side simply never injects the loader script), so this ships inert
-- until an admin fills both in.
INSERT INTO "public"."settings" ("key", "value")
VALUES
  ('sentry_dsn', ''),
  ('sentry_browser_loader_url', '')
ON CONFLICT ("key") DO NOTHING;
