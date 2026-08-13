/**
 * Sentry error capture, shared across every Edge Function.
 *
 * The DSN lives in the settings table (sentry_dsn), not a Supabase secret -
 * matching how every other integration (Stripe, Zoho, The SMS Works) is
 * configured in this app: admin-editable via settings.html, no redeploy
 * needed to rotate or reconfigure. No-ops cleanly whenever that setting is
 * empty - never blocks or breaks a function's own response just because
 * monitoring isn't configured yet.
 *
 * Sentry is deliberately PLATFORM-level infrastructure, not a per-tenant
 * integration (E5-19) - unlike Stripe/Zoho/SMS, every admin dashboard page's
 * own CSP hardcodes a single Sentry ingest host in connect-src, so browser
 * error reporting could never actually reach more than one Sentry project
 * regardless of what any organisation configured. getDsn() below reads only
 * org_default's row explicitly, rather than an unscoped `key` lookup, so a
 * tenant organisation's own (inert, UI-hidden) sentry_dsn row can never be
 * selected instead of - or cause a query failure alongside - the real
 * platform configuration.
 *
 * defaultIntegrations: false because the Sentry Deno SDK does not support
 * Deno.serve instrumentation - without this, integrations that assume a
 * single long-lived server process leak state (breadcrumbs, scope) across
 * requests whenever the Edge Runtime reuses an isolate. No
 * tracesSampleRate/profilesSampleRate: this is error monitoring only, the
 * same scope decision already made for the browser-side integration.
 *
 * captureAndFlush() is always awaited by its callers, never fire-and-forget:
 * the isolate can be torn down immediately after a function returns its
 * response, which would silently drop an in-flight, unflushed event. See
 * https://supabase.com/docs/guides/functions/examples/sentry-monitoring.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import * as Sentry from 'npm:@sentry/deno@^8'

let initialized = false
// undefined = not yet fetched; null = fetched, but unset/empty. Cached for
// the lifetime of the warm isolate so a burst of errors doesn't re-query
// settings for every single one.
let cachedDsn: string | null | undefined = undefined

async function getDsn(): Promise<string | null> {
  if (cachedDsn !== undefined) return cachedDsn
  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )
    const { data } = await supabaseAdmin.from('settings').select('value').eq('org_id', 'org_default').eq('key', 'sentry_dsn').single()
    cachedDsn = data?.value || null
  } catch {
    // Settings read failed (network hiccup, row missing pre-migration) -
    // treat as unconfigured rather than throwing; captureAndFlush's own
    // try/catch would swallow this anyway, but resolving explicitly avoids
    // re-attempting the query on every single error in this isolate.
    cachedDsn = null
  }
  return cachedDsn
}

async function ensureInit(): Promise<boolean> {
  const dsn = await getDsn()
  if (!dsn) return false
  if (!initialized) {
    Sentry.init({
      dsn,
      defaultIntegrations: false,
    })
    initialized = true
  }
  return true
}

/**
 * Captures an unexpected error and waits for it to actually send.
 *
 * `context` tags the event with which function threw (e.g. 'refund-payment')
 * so issues group and filter sensibly in Sentry rather than all landing
 * under one undifferentiated bucket. `extraTags` is for anything else worth
 * correlating - e.g. the same reference id already shown to the caller in
 * _shared/errors.ts's generic error message, so a stallholder quoting that
 * reference can be found directly.
 *
 * Swallows its own failures (a Sentry outage, a bad DSN, a network error)
 * rather than letting error reporting become a second reason the original
 * request fails.
 */
export async function captureAndFlush(
  error: unknown,
  context: string,
  extraTags?: Record<string, string>
): Promise<void> {
  try {
    if (!(await ensureInit())) return
    Sentry.withScope((scope) => {
      scope.setTag('function', context)
      if (extraTags) {
        for (const [key, value] of Object.entries(extraTags)) scope.setTag(key, value)
      }
      Sentry.captureException(error)
    })
    await Sentry.flush(2000)
  } catch (sentryError) {
    console.warn(`[sentry] capture failed for ${context}:`, sentryError)
  }
}
