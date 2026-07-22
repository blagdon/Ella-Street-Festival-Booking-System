/**
 * Safe error responses for the PUBLIC, unauthenticated Edge Functions
 * (submit-booking, cancel-booking).
 *
 * Both used to end in `catch (error) { return { error: error.message } }` with
 * a 500. That catch sees two very different kinds of error:
 *
 *   - Deliberate validation messages written FOR the trader ("Invalid
 *     stall_type."), which are safe and useful to show.
 *   - Anything unexpected — a Postgres error, an RPC failure, a missing
 *     server env var — whose message can carry table names, column names,
 *     constraint names, or server configuration state. Those went straight to
 *     an anonymous caller.
 *
 * The message text is not itself a secret (the schema isn't confidential, and
 * the anon key is public by design — RLS is the real boundary). But handing an
 * unauthenticated caller a map of the schema and a live signal for which
 * server-side settings are missing makes probing the app considerably easier,
 * for no benefit to a legitimate trader who cannot act on "duplicate key value
 * violates unique constraint bookings_pkey" anyway.
 *
 * ALLOW-LIST, NOT DENY-LIST. js/utils.js's safeError() takes the opposite
 * approach client-side: it pattern-matches known-dangerous messages and passes
 * anything else through. That is the right trade for admin-facing UI, where the
 * caller is trusted and a useful message matters more. It fails OPEN, though —
 * a message that matches no pattern is shown verbatim — which is the wrong
 * default at a public boundary. Here, only messages explicitly marked
 * `PublicError` are ever echoed; everything else becomes generic. A new throw
 * site added later is safe by default rather than leaky by default.
 *
 * NOT for the admin-authenticated functions. They keep their detailed errors
 * deliberately: the caller is a trusted admin, the detail is what makes a
 * failure diagnosable from the UI, and several suites in tests/ assert on those
 * exact messages (refunds, get-reviews, retry-queued-email, create-checkout-
 * session). Don't extend this to them without a reason.
 */

/**
 * An error whose message is written for the end user and is safe to return
 * verbatim from a public endpoint.
 */
export class PublicError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'PublicError'
    this.status = status
  }
}

/**
 * Short, non-guessable id tying a generic client response to the full error in
 * the function logs, so "it failed" is still supportable without the response
 * carrying any detail.
 */
function newErrorReference(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

/**
 * Maps any thrown value to a client-safe { message, status }.
 *
 * A PublicError passes through as written. Anything else is logged in full
 * (server side, where it is useful) and replaced with a generic message
 * carrying a reference id that appears in that log line.
 */
export function toPublicError(
  error: unknown,
  context: string
): { message: string; status: number } {
  if (error instanceof PublicError) {
    return { message: error.message, status: error.status }
  }

  const reference = newErrorReference()
  const detail = error instanceof Error ? (error.stack || error.message) : String(error)
  console.error(`[${context}] unexpected error (ref ${reference}):`, detail)

  return {
    message:
      `Something went wrong on our end and your request could not be completed. ` +
      `Please try again, and if it keeps happening quote reference ${reference} when you get in touch.`,
    status: 500
  }
}

/**
 * Convenience wrapper building the Response itself, so each function's catch
 * block is a single line and cannot forget to sanitise.
 */
export function publicErrorResponse(
  error: unknown,
  context: string,
  corsHeaders: Record<string, string>
): Response {
  const { message, status } = toPublicError(error, context)
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}
