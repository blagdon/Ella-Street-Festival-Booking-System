import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=deno'
import { sendViaZoho } from '../_shared/zoho.ts'
import { getStripeWebhookSecret, loadStripeSettings } from '../_shared/stripe.ts'
import { escapeHtml } from '../_shared/format.ts'

/**
 * Best-effort confirmation email after a successful Stripe payment — reuses
 * the exact same "confirmed_chargeable" template already used for manual
 * chargeable confirmations (js/shared.js's getEmailFromTemplate). Own
 * inline placeholder substitution, matching the existing submit-booking/
 * cancel-booking precedent of each function having its own small
 * replaceVars rather than sharing one across functions.
 *
 * Throws are caught by the caller — a failed email must never fail the
 * webhook response, since the financial state change (the RPCs) already
 * committed successfully by the time this runs.
 */
async function sendConfirmationEmail(supabaseAdmin: ReturnType<typeof createClient>, bookingId: string) {
  const { data: booking, error: bookingErr } = await supabaseAdmin
    .from('bookings')
    .select('email, owner_name, business_name, instance_prefix, cancel_token, stall_cost')
    .eq('id', bookingId)
    .single()

  if (bookingErr || !booking?.email) {
    throw new Error('Could not load booking for confirmation email: ' + (bookingErr?.message || 'not found'))
  }

  const { data: templateData, error: templateErr } = await supabaseAdmin
    .from('email_templates')
    .select('subject, body_html')
    .eq('id', 'confirmed_chargeable')
    .single()

  if (templateErr || !templateData) {
    throw new Error('Could not load "confirmed_chargeable" email template: ' + (templateErr?.message || 'not found'))
  }

  const { data: settingsRows } = await supabaseAdmin
    .from('settings')
    .select('key, value')
    .in('key', ['cancel_url', 'bank_account_name', 'bank_sort_code', 'bank_account_number'])
  const settingsMap: Record<string, string> = {}
  ;(settingsRows || []).forEach((r: any) => { settingsMap[r.key] = r.value })

  const costStr = (booking.stall_cost !== undefined && booking.stall_cost !== null)
    ? `£${parseFloat(booking.stall_cost).toFixed(2)}`
    : 'the agreed fee'
  const cancelBase = settingsMap['cancel_url'] || ''
  const cancelLink = (booking.cancel_token && cancelBase)
    ? `${cancelBase}?token=${encodeURIComponent(booking.cancel_token)}`
    : (cancelBase || '')
  // Built from the same structured settings used for the payment_requested
  // template's bank-transfer instructions (create-checkout-session) — no
  // separate freeform 'bank_details' setting anymore, it duplicated this.
  const bankDetails = `Account Name: ${escapeHtml(settingsMap['bank_account_name'] || '')}, Sort Code: ${escapeHtml(settingsMap['bank_sort_code'] || '')}, Account Number: ${escapeHtml(settingsMap['bank_account_number'] || '')}`

  const replaceVars = (str: string) =>
    (str || '')
      .replace(/\{\{owner_name\}\}/g, escapeHtml(booking.owner_name || 'Trader'))
      .replace(/\{\{business_name\}\}/g, escapeHtml(booking.business_name || 'your business'))
      .replace(/\{\{booking_id\}\}/g, bookingId || '')
      .replace(/\{\{cancel_link\}\}/g, cancelLink)
      .replace(/\{\{cost\}\}/g, costStr)
      .replace(/\{\{bank_details\}\}/g, bankDetails)
      // Not settled yet at confirmation time — location allocation happens
      // later, as a fully separate process. Never populate with a stale/
      // fabricated value.
      .replace(/\{\{location_id\}\}/g, 'TBA')
      .replace(/\{\{reason\}\}/g, '')

  const subject = replaceVars(templateData.subject)
  const body = replaceVars(templateData.body_html)

  let status = 'Sent'
  let errorMessage: string | null = null
  try {
    await sendViaZoho(supabaseAdmin, { recipient: booking.email, subject, body })
  } catch (e: any) {
    status = 'Error'
    errorMessage = e.message
  }

  const { error: logErr } = await supabaseAdmin.from('email_queue').insert({
    recipient: booking.email,
    subject,
    body,
    status,
    error_message: errorMessage,
    instance_prefix: booking.instance_prefix || null
  })
  if (logErr) console.warn('Failed to write to email_queue log:', logErr.message)

  if (status === 'Error') throw new Error(errorMessage || 'Failed to send email')
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const signature = req.headers.get('stripe-signature')
  // Read the RAW body before any JSON parsing — Stripe signature
  // verification is computed over the exact raw bytes Stripe sent.
  const rawBody = await req.text()

  if (!signature) {
    return new Response(JSON.stringify({ error: 'Missing Stripe-Signature header.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Needs a Supabase client before signature verification now, since the
  // webhook signing secrets themselves live in the settings table (see
  // _shared/stripe.ts) rather than an Edge Function env var — admin-
  // editable via settings.html, no CLI/redeploy needed to rotate them.
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  let stripeSettings
  try {
    stripeSettings = await loadStripeSettings(supabaseAdmin)
  } catch (e: any) {
    console.error('Failed to load Stripe settings:', e.message)
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Instantiated purely to reach the .webhooks namespace — the API key
  // itself plays no role in signature verification, which depends only on
  // the raw payload, the signature header, and the webhook signing secret.
  const stripeForVerification = new Stripe('sk_unused_placeholder', {
    apiVersion: '2024-06-20', httpClient: Stripe.createFetchHttpClient()
  })
  const cryptoProvider = Stripe.createSubtleCryptoProvider()

  // One endpoint URL receives both Test-mode and Live-mode events (Stripe
  // supports registering the same URL separately under each dashboard,
  // each producing its own signing secret) — try both configured secrets.
  let event: any = null
  for (const mode of ['test', 'live'] as const) {
    try {
      const secret = getStripeWebhookSecret(mode, stripeSettings)
      event = await stripeForVerification.webhooks.constructEventAsync(rawBody, signature, secret, undefined, cryptoProvider)
      break
    } catch (_e) {
      // Wrong secret for this event, or that mode's secret isn't
      // configured — try the other mode before giving up.
    }
  }

  if (!event) {
    return new Response(JSON.stringify({ error: 'Webhook signature verification failed.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      if (session.payment_status === 'paid') {
        const bookingId: string | undefined = session.metadata?.booking_id || session.client_reference_id

        if (!bookingId) {
          console.warn('checkout.session.completed with no booking_id metadata/client_reference_id, session:', session.id)
        } else {
          const paymentIntentId: string = typeof session.payment_intent === 'string'
            ? session.payment_intent
            : (session.payment_intent?.id || session.id)

          // Idempotency boundary for the financial state itself: this RPC is
          // a single atomic transaction (status update + payments upsert),
          // and is a safe no-op if the booking isn't currently 'Payment
          // Requested' (see the migration's comments).
          const { error: rpcErr } = await supabaseAdmin.rpc('finalize_stripe_payment', {
            p_booking_id: bookingId,
            p_payment_intent_id: paymentIntentId
          })
          if (rpcErr) throw new Error('finalize_stripe_payment failed: ' + rpcErr.message)

          // Idempotency boundary for the EMAIL send specifically: only the
          // first delivery of this exact Stripe event id to fully complete
          // processing sends the confirmation email. A 23505 unique-
          // violation here means a prior delivery of this same event
          // already got this far (mirrors the existing retry-on-23505
          // pattern used for booking-ID generation in submit-booking).
          const { error: ledgerErr } = await supabaseAdmin
            .from('stripe_webhook_events')
            .insert({ event_id: event.id, event_type: event.type })

          const alreadyProcessed = !!ledgerErr && (ledgerErr as any).code === '23505'
          if (ledgerErr && !alreadyProcessed) {
            console.warn('Failed to record stripe_webhook_events row (non-fatal):', ledgerErr.message)
          }

          if (!alreadyProcessed) {
            try {
              await sendConfirmationEmail(supabaseAdmin, bookingId)
            } catch (emailErr: any) {
              console.warn('Failed to send confirmed_chargeable email after Stripe payment:', emailErr.message)
            }
          }
        }
      }
    } else if (event.type === 'checkout.session.expired' || event.type === 'payment_intent.payment_failed') {
      // No DB writes needed — the booking is already correctly sitting at
      // 'Payment Requested' (see the migration's comments on why there's no
      // separate ledger/status change for this case). Just acknowledge.
      console.log(`Acknowledged ${event.type} (event ${event.id}) — no action needed, booking stays in Payment Requested.`)
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error: any) {
    console.error('stripe-webhook processing error:', error.message)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})
