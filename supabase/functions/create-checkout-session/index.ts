import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendViaZoho } from '../_shared/zoho.ts'
import { resolveStripeMode, getStripeClient, loadStripeSettings } from '../_shared/stripe.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Mirrors js/utils.js's escapeHtml() exactly (same reason cancel-booking has its own copy).
function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

// A second "Request Payment"/"Resend" click within this window reuses the
// existing session/email instead of creating a duplicate Stripe Checkout
// Session and re-emailing the stallholder. Cheap protection against an
// admin double-click; not a correctness requirement (a genuine second
// session would be harmless — the RPC status guard in the webhook makes a
// stray extra session's completion a safe no-op — this is purely to avoid
// sending two "pay now" emails for one click).
const DUPLICATE_REQUEST_WINDOW_MS = 10_000

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Admin-only — same pattern as queue-bulk-email (no service-role
    // "trusted call" bypass needed here since this is only ever called from
    // an authenticated admin's own browser session).
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token)
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized: ' + authError?.message }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { data: roleData, error: roleError } = await supabaseClient
      .from('user_roles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (roleError || !roleData || roleData.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Forbidden: Admin role required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { booking_id, cost: costOverride } = await req.json()
    if (!booking_id || typeof booking_id !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing booking_id.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { data: booking, error: bookingErr } = await supabaseClient
      .from('bookings')
      .select('id, status, stall_cost, instance_prefix, business_name, owner_name, email, stripe_payment_requested_at, stripe_checkout_session_id, cancel_token')
      .eq('id', booking_id)
      .single()

    if (bookingErr || !booking) {
      return new Response(JSON.stringify({ error: 'Booking not found.' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // The admin confirms a booking as chargeable and this fires straight
    // away (no more separate "Pre-Confirmed" step) — so a payment request
    // can now originate from Pending/On Hold/HCC Checks as well as being
    // resent from Payment Requested. Only reject statuses that have already
    // been resolved one way or another.
    if (['Confirmed', 'Paid', 'Rejected', 'Cancelled'].includes(booking.status)) {
      return new Response(JSON.stringify({ error: `Cannot request payment from status '${booking.status}'.` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Cost is normally supplied by the caller (the admin's chargeable-confirm
    // cost, possibly overridden in the modal) since there's no longer a
    // separate step that persists it first. Falls back to the booking's
    // already-stored stall_cost for a plain "Resend Payment Request" call.
    const cost = (costOverride !== undefined && costOverride !== null)
      ? parseFloat(costOverride)
      : parseFloat(booking.stall_cost)
    if (!cost || isNaN(cost) || cost <= 0) {
      return new Response(JSON.stringify({ error: 'Booking has no valid stall cost set — cannot create a payment request for £0 or an unset cost.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!booking.email) {
      return new Response(JSON.stringify({ error: 'Booking has no email address on file.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Double-click guard.
    if (booking.stripe_payment_requested_at) {
      const lastRequestedMs = new Date(booking.stripe_payment_requested_at).getTime()
      if (Date.now() - lastRequestedMs < DUPLICATE_REQUEST_WINDOW_MS) {
        return new Response(JSON.stringify({ error: 'A payment request was already sent moments ago — please wait a few seconds before resending.' }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }

    const { data: settingsRows } = await supabaseClient
      .from('settings')
      .select('key, value')
      .in('key', ['base_url', 'cancel_url'])
    const settingsMap: Record<string, string> = {}
    ;(settingsRows || []).forEach((r: any) => { settingsMap[r.key] = r.value })
    const baseUrl = settingsMap['base_url'] || 'https://app.ellastreet.co.uk'

    const stripeSettings = await loadStripeSettings(supabaseClient)
    const mode = resolveStripeMode(booking.instance_prefix, stripeSettings.testModeSetting)
    const stripe = getStripeClient(mode, stripeSettings)

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'gbp',
          unit_amount: Math.round(cost * 100),
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

    const nowIso = new Date().toISOString()
    const { error: updateErr } = await supabaseClient
      .from('bookings')
      .update({
        stall_cost: cost,
        stripe_checkout_session_id: session.id,
        stripe_payment_requested_at: nowIso,
        status: 'Payment Requested'
      })
      .eq('id', booking.id)

    if (updateErr) {
      throw new Error('Failed to update booking after creating Checkout Session: ' + updateErr.message)
    }

    // Send the payment-request email — best-effort, matching the rest of
    // this repo's send-then-log pattern. Own inline placeholder
    // substitution (same precedent as submit-booking/cancel-booking, each
    // of which has its own small replaceVars rather than sharing one).
    try {
      const { data: templateData, error: templateErr } = await supabaseClient
        .from('email_templates')
        .select('subject, body_html')
        .eq('id', 'payment_requested')
        .single()

      if (templateErr || !templateData) {
        throw new Error('Could not load "payment_requested" email template: ' + (templateErr?.message || 'not found'))
      }

      const costStr = `£${cost.toFixed(2)}`
      const cancelBase = settingsMap['cancel_url'] || ''
      const cancelLink = (booking.cancel_token && cancelBase)
        ? `${cancelBase}?token=${encodeURIComponent(booking.cancel_token)}`
        : (cancelBase || '')
      const replaceVars = (str: string) =>
        (str || '')
          .replace(/\{\{owner_name\}\}/g, escapeHtml(booking.owner_name || 'Trader'))
          .replace(/\{\{business_name\}\}/g, escapeHtml(booking.business_name || 'your business'))
          .replace(/\{\{booking_id\}\}/g, booking.id || '')
          .replace(/\{\{cost\}\}/g, costStr)
          .replace(/\{\{payment_link\}\}/g, session.url as string)
          .replace(/\{\{cancel_link\}\}/g, cancelLink)

      const subject = replaceVars(templateData.subject)
      const body = replaceVars(templateData.body_html)

      let emailStatus = 'Sent'
      let emailError: string | null = null
      try {
        await sendViaZoho(supabaseClient, { recipient: booking.email, subject, body })
      } catch (e: any) {
        emailStatus = 'Error'
        emailError = e.message
      }

      await supabaseClient.from('email_queue').insert({
        recipient: booking.email,
        subject,
        body,
        status: emailStatus,
        error_message: emailError,
        instance_prefix: booking.instance_prefix || null
      })
    } catch (emailErr: any) {
      console.warn('Failed to send payment_requested email:', emailErr.message)
    }

    return new Response(JSON.stringify({ success: true, checkout_url: session.url }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
