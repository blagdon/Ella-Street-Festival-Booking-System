import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'
import { PublicError, publicErrorResponse } from '../_shared/errors.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Stripe Checkout Sessions expire 24h after creation by default, and
// create-checkout-session never overrides expires_at - so this is a reliable
// heuristic, not a guess. stripe_payment_requested_at is updated to now() on
// every request AND every resend (same update call that sets the session
// url), so it always reflects the currently-active session's creation time,
// never a stale first-ever request. This can't confirm Stripe's actual
// server-side state (an admin could someday change expires_at, or the
// session could already be completed) - it's a cheap, local approximation
// that avoids redirecting into Stripe's own bare "session expired" page with
// no ESF context, using data already being tracked for the double-click
// guard in create-checkout-session.
const CHECKOUT_SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000

/**
 * Public, unauthenticated redirect-target lookup for pay.html — resolves the
 * short link embedded in the payment_requested SMS (`pay.html?token=<short
 * payment_link_code>`) back to the actual Stripe Checkout URL stored on the
 * booking at creation time (create-checkout-session's `stripe_checkout_url`
 * column), so the SMS never has to carry Stripe's own ~400+ character URL.
 *
 * The token is `bookings.payment_link_code` — an 8-character random code
 * every booking gets by default (see the `20260731110000_payment_link_short_
 * code.sql` migration), not the Stripe Checkout Session id itself; that
 * earlier design (20260731100000) worked but made for a needlessly long
 * (~110 char) visible SMS link.
 *
 * Read-only lookup, no state change - unlike cancel-booking this isn't
 * destructive, so it isn't gated behind Turnstile.
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { token } = await req.json()
    if (!token || typeof token !== 'string') {
      throw new PublicError('Missing payment link token.')
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: booking, error } = await supabaseClient
      .from('bookings')
      .select('status, stripe_checkout_url, stripe_payment_requested_at')
      .eq('payment_link_code', token)
      .single()

    if (error || !booking || !booking.stripe_checkout_url) {
      throw new PublicError('This payment link is invalid or has expired.', 404)
    }

    // Anything other than 'Payment Requested' means the underlying Stripe
    // session is stale (already paid, or the booking moved on some other
    // way) - redirecting into it would either double-charge confusion or
    // just show Stripe's own expired-session page with no context.
    if (booking.status !== 'Payment Requested') {
      throw new PublicError('This booking is no longer awaiting payment — no further action is needed.')
    }

    // See CHECKOUT_SESSION_EXPIRY_MS above - a booking can sit in
    // 'Payment Requested' for days if nobody resends, long after Stripe's
    // own session has expired. Catch that here rather than redirecting into
    // Stripe's bare error page.
    if (booking.stripe_payment_requested_at) {
      const requestedMs = new Date(booking.stripe_payment_requested_at).getTime()
      if (Date.now() - requestedMs > CHECKOUT_SESSION_EXPIRY_MS) {
        throw new PublicError('This payment link has expired. Please contact us for a new payment link.')
      }
    }

    return new Response(JSON.stringify({ success: true, checkout_url: booking.stripe_checkout_url }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (error: any) {
    return publicErrorResponse(error, 'get-payment-link', corsHeaders)
  }
})
