/**
 * Sentry error capture, shared across every Edge Function.
 *
 * No-op whenever SENTRY_DSN isn't set on a given project - never blocks or
 * breaks a function's own response just because monitoring isn't configured
 * there yet (e.g. before the test project has the secret set).
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
import * as Sentry from 'npm:@sentry/deno@^8'

let initialized = false

function ensureInit(): boolean {
  const dsn = Deno.env.get('SENTRY_DSN')
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
    if (!ensureInit()) return
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
