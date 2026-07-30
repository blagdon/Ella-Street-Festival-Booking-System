import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'
import { PublicError, publicErrorResponse } from '../_shared/errors.ts'
import { verifyTurnstile } from '../_shared/turnstile.ts'
import { resolveStripeMode, getStripeClient, loadStripeSettings } from '../_shared/stripe.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Stripe Checkout Sessions expire 24h after creation by default - this is
// both "how long a stored session is still considered usable" and the
// window rpc_claim_stripe_session_slot uses to decide a fresh one is needed.
const SESSION_FRESHNESS_SECONDS = 24 * 60 * 60

// A much shorter lease for a claim that never got a checkout_url stored -
// the Stripe API call itself failed, and the revert below either hasn't run
// yet or (isolate crash, network drop) never will. Without this, that slot
// would otherwise be stuck for the full 24h SESSION_FRESHNESS_SECONDS with
// nothing to self-heal it (no webhook fires - no Stripe object was ever
// created). See rpc_claim_stripe_session_slot's own migration comment
// (20260731180000) for why 2 minutes is safely clear of a merely-slow
// (not crashed) in-flight claim.
const UNFULFILLED_CLAIM_SECONDS = 2 * 60

// How long, and how many times, to wait for a concurrent request that has
// already claimed the slot (created moments ago, Stripe hasn't responded
// yet) to finish writing the real checkout_url - rather than serving a
// stale/missing link, or wastefully creating a second session ourselves.
// 3 x 700ms comfortably covers Stripe's typical response time; if it's
// still not there, something is genuinely wrong and the caller gets a clear
// "try again" rather than hanging indefinitely.
const CLAIM_WAIT_ATTEMPTS = 3
const CLAIM_WAIT_MS = 700

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Public, unauthenticated redirect-target lookup for pay.html — resolves the
 * short link embedded in the payment_requested email/SMS
 * (`pay.html?paymentToken=<payment_link_code>`) to a real Stripe Checkout
 * URL, creating one lazily on the caller's behalf if none exists yet or the
 * stored one has passed Stripe's 24h default expiry. This means a
 * stallholder who waits days before clicking always lands on a session
 * created moments ago, rather than one requested at send-time and long
 * since expired.
 *
 * Now state-changing (creates real, costed Stripe sessions), unlike before —
 * gated behind Turnstile for the same reason submit-booking/cancel-booking
 * are: a public endpoint that can spend money must not be a bare, ungated
 * lookup.
 *
 * The token is `bookings.payment_link_code` — an 8-character random code
 * every booking gets by default (see the `20260731110000_payment_link_short_
 * code.sql` migration). The charged amount is `stripe_requested_cost`
 * (20260731120000), frozen by create-checkout-session at request/resend
 * time — never the live `stall_cost`, which Update Details can edit anytime
 * regardless of an outstanding payment request.
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { token, paymentToken } = await req.json()

    if (!paymentToken || typeof paymentToken !== 'string') {
      throw new PublicError('Missing payment link token.')
    }

    await verifyTurnstile(token)

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Atomically claim the right to (re)create a session for this booking.
    // Only succeeds if it's still Payment Requested AND the stored session
    // is missing or stale — see the RPC's own comment for why this must be
    // a single atomic statement, not a plain read-then-write.
    const { data: claimedRows, error: claimErr } = await supabaseClient.rpc('rpc_claim_stripe_session_slot', {
      p_payment_link_code: paymentToken,
      p_freshness_seconds: SESSION_FRESHNESS_SECONDS,
      p_unfulfilled_claim_seconds: UNFULFILLED_CLAIM_SECONDS,
    })
    if (claimErr) throw new Error('Failed to claim payment session slot: ' + claimErr.message)

    if (claimedRows && claimedRows.length > 0) {
      // Won the claim — build a fresh session now.
      const booking = claimedRows[0] as any

      if (!booking.stripe_requested_cost || booking.stripe_requested_cost <= 0) {
        throw new Error(`Booking ${booking.id} has no valid stripe_requested_cost — cannot create a Checkout Session.`)
      }

      try {
        const { data: settingsRows } = await supabaseClient
          .from('settings')
          .select('value')
          .eq('key', 'base_url')
          .single()
        const baseUrl = settingsRows?.value || 'https://app.ellastreet.co.uk'

        const stripeSettings = await loadStripeSettings(supabaseClient)
        const mode = resolveStripeMode(booking.instance_prefix, stripeSettings.testModeSetting)
        const stripe = getStripeClient(mode, stripeSettings)

        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          line_items: [{
            price_data: {
              currency: 'gbp',
              unit_amount: Math.round(booking.stripe_requested_cost * 100),
              product_data: {
                name: `Stall fee — ${booking.business_name || 'Booking'} (${booking.id})`
              }
            },
            quantity: 1
          }],
          customer_email: booking.email,
          client_reference_id: booking.id,
          metadata: { booking_id: booking.id },
          success_url: `${baseUrl}/payment_success.html?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${baseUrl}/payment_cancelled.html?booking_id=${encodeURIComponent(booking.id)}`
        })

        if (!session.url) {
          throw new Error('Stripe did not return a Checkout Session URL.')
        }

        const { error: updateErr } = await supabaseClient
          .from('bookings')
          .update({ stripe_checkout_session_id: session.id, stripe_checkout_url: session.url })
          .eq('id', booking.id)
        if (updateErr) throw new Error('Failed to store the new Checkout Session: ' + updateErr.message)

        return new Response(JSON.stringify({ success: true, checkout_url: session.url }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      } catch (stripeErr: any) {
        // Best-effort revert so an IMMEDIATE next click retries cleanly,
        // rather than waiting out even UNFULFILLED_CLAIM_SECONDS. Not load-
        // bearing for correctness, though: if this update itself never runs
        // (isolate crash, network drop right here), the claim isn't stuck
        // for SESSION_FRESHNESS_SECONDS - rpc_claim_stripe_session_slot's own
        // shorter lease for an unfulfilled claim (stripe_checkout_url still
        // null) is what actually bounds the worst case now. Re-throw the
        // ORIGINAL error (not a PublicError) so it reaches the generic
        // branch below — a Stripe failure is a genuine, unexpected problem
        // worth a Sentry capture and a reference code, not a normal
        // user-facing rejection.
        await supabaseClient.from('bookings').update({ stripe_session_claimed_at: null }).eq('id', booking.id)
        throw stripeErr
      }
    }

    // Not claimed: either this booking doesn't exist / isn't awaiting
    // payment, or a fresh session already exists (the common case — a
    // repeat click). Re-read rather than trust an earlier check, since
    // status could have moved on in between (e.g. paid via another tab).
    for (let attempt = 0; ; attempt++) {
      const { data: current, error: readErr } = await supabaseClient
        .from('bookings')
        .select('status, stripe_checkout_url')
        .eq('payment_link_code', paymentToken)
        .single()

      if (readErr || !current) {
        throw new PublicError('This payment link is invalid or has expired.', 404)
      }
      if (current.status !== 'Payment Requested') {
        // 409, not the default 400 - a terminal state (already paid via
        // another channel, cancelled, etc.), not something retrying could
        // ever fix. The frontend uses this to hide the Continue button
        // rather than leaving it sitting next to a message saying there's
        // nothing left to do.
        throw new PublicError('This booking is no longer awaiting payment — no further action is needed.', 409)
      }
      if (current.stripe_checkout_url) {
        return new Response(JSON.stringify({ success: true, checkout_url: current.stripe_checkout_url }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Still Payment Requested but no URL yet — another request just
      // claimed the slot and is still waiting on Stripe. Wait briefly and
      // re-check rather than serve a broken link.
      if (attempt + 1 >= CLAIM_WAIT_ATTEMPTS) {
        throw new PublicError('Your payment link is still being prepared — please try again in a few seconds.')
      }
      await sleep(CLAIM_WAIT_MS)
    }
  } catch (error: any) {
    return publicErrorResponse(error, 'get-payment-link', corsHeaders)
  }
})
