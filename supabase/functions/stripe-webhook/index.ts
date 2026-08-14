import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=deno'
import { sendViaZoho } from '../_shared/zoho.ts'
import { sendViaSms, normalizePhone } from '../_shared/sms.ts'
import { getStripeClient, loadStripeSettings, type StripeMode } from '../_shared/stripe.ts'
import { escapeHtml, formatCurrency } from '../_shared/format.ts'
import { captureAndFlush } from '../_shared/sentry.ts'

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
    .select('org_id, email, owner_name, business_name, instance_prefix, cancel_token, stall_cost')
    .eq('id', bookingId)
    .single()

  if (bookingErr || !booking?.email) {
    throw new Error('Could not load booking for confirmation email: ' + (bookingErr?.message || 'not found'))
  }

  const { data: templateData, error: templateErr } = await supabaseAdmin
    .from('email_templates')
    .select('subject, body_html')
    .eq('org_id', booking.org_id)
    .eq('id', 'confirmed_chargeable')
    .single()

  if (templateErr || !templateData) {
    throw new Error('Could not load "confirmed_chargeable" email template: ' + (templateErr?.message || 'not found'))
  }

  const { data: settingsRows } = await supabaseAdmin
    .from('settings')
    .select('key, value')
    .eq('org_id', booking.org_id)
    .in('key', ['cancel_url', 'bank_account_name', 'bank_sort_code', 'bank_account_number'])
  const settingsMap: Record<string, string> = {}
  ;(settingsRows || []).forEach((r: any) => { settingsMap[r.key] = r.value })

  const costStr = (booking.stall_cost !== undefined && booking.stall_cost !== null)
    ? formatCurrency(parseFloat(booking.stall_cost))
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
    await sendViaZoho(supabaseAdmin, { recipient: booking.email, subject, body }, booking.org_id)
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
    instance_prefix: booking.instance_prefix || null,
    org_id: booking.org_id
  })
  if (logErr) console.warn('Failed to write to email_queue log:', logErr.message)

  if (status === 'Error') throw new Error(errorMessage || 'Failed to send email')
}

/**
 * Best-effort confirmation text after a successful Stripe payment — the SMS
 * counterpart to sendConfirmationEmail(), reusing the same "booking_confirmed"
 * template the free-confirm path already sends (js/shared.js's
 * maybeSendStatusSms), so a Stripe-paid confirmation reads identically to a
 * free one: cost, bank details, and a cancel link.
 *
 * No opt-in tickbox: like submit-booking's sendReceivedSms, there is no admin
 * present when this webhook fires, so it sends automatically whenever the
 * booking has a phone number — reported live as a gap: confirming a
 * chargeable booking via Stripe Checkout never sent any text at all, only
 * the email, unlike the free-confirm path which already had this.
 *
 * Skipped entirely (no sms_queue row) when there's no phone number — nothing
 * was ever going to be attempted. Throws are caught by the caller, same
 * contract as sendConfirmationEmail — a failed text must never fail the
 * webhook response, since the financial state change already committed.
 */
async function sendConfirmationSms(supabaseAdmin: ReturnType<typeof createClient>, bookingId: string) {
  const { data: booking, error: bookingErr } = await supabaseAdmin
    .from('bookings')
    .select('org_id, phone, owner_name, business_name, instance_prefix, cancel_token, stall_cost')
    .eq('id', bookingId)
    .single()

  if (bookingErr || !booking) {
    throw new Error('Could not load booking for confirmation SMS: ' + (bookingErr?.message || 'not found'))
  }
  if (!booking.phone) return

  const { data: templateData, error: templateErr } = await supabaseAdmin
    .from('sms_templates')
    .select('body')
    .eq('org_id', booking.org_id)
    .eq('id', 'booking_confirmed')
    .single()

  if (templateErr || !templateData) {
    throw new Error('Could not load "booking_confirmed" SMS template: ' + (templateErr?.message || 'not found'))
  }

  const { data: settingsRows } = await supabaseAdmin
    .from('settings')
    .select('key, value')
    .eq('org_id', booking.org_id)
    .in('key', ['cancel_url', 'bank_account_name', 'bank_sort_code', 'bank_account_number'])
  const settingsMap: Record<string, string> = {}
  ;(settingsRows || []).forEach((r: any) => { settingsMap[r.key] = r.value })

  const costStr = (booking.stall_cost !== undefined && booking.stall_cost !== null)
    ? formatCurrency(parseFloat(booking.stall_cost))
    : 'the agreed fee'
  const cancelBase = settingsMap['cancel_url'] || ''
  const cancelLink = (booking.cancel_token && cancelBase)
    ? `${cancelBase}?token=${encodeURIComponent(booking.cancel_token)}`
    : (cancelBase || '')
  // Plain text, not escapeHtml()'d, unlike sendConfirmationEmail's copy.
  const bankDetails = `Account Name: ${settingsMap['bank_account_name'] || ''}, Sort Code: ${settingsMap['bank_sort_code'] || ''}, Account Number: ${settingsMap['bank_account_number'] || ''}`

  const body = templateData.body
    .replace(/\{\{owner_name\}\}/g, booking.owner_name || 'Trader')
    .replace(/\{\{business_name\}\}/g, booking.business_name || 'your business')
    .replace(/\{\{booking_id\}\}/g, bookingId || '')
    .replace(/\{\{cost\}\}/g, costStr)
    .replace(/\{\{bank_details\}\}/g, bankDetails)
    .replace(/\{\{cancel_link\}\}/g, cancelLink)

  let recipient: string
  try {
    recipient = normalizePhone(booking.phone)
  } catch (e: any) {
    const { error: logErr } = await supabaseAdmin.from('sms_queue').insert({
      recipient: booking.phone,
      body,
      status: 'Error',
      error_message: e.message,
      instance_prefix: booking.instance_prefix || null,
      org_id: booking.org_id
    })
    if (logErr) console.warn('Failed to write to sms_queue log:', logErr.message)
    throw e
  }

  let status = 'Sent'
  let errorMessage: string | null = null
  let providerMessageId: string | null = null
  let segments: number | null = null
  try {
    const result = await sendViaSms(supabaseAdmin, { recipient, body }, booking.org_id)
    providerMessageId = result.providerMessageId
    segments = result.segments
  } catch (e: any) {
    status = 'Error'
    errorMessage = e.message
  }

  const { error: logErr } = await supabaseAdmin.from('sms_queue').insert({
    recipient,
    body,
    status,
    error_message: errorMessage,
    provider_message_id: providerMessageId,
    segments,
    instance_prefix: booking.instance_prefix || null,
    org_id: booking.org_id
  })
  if (logErr) console.warn('Failed to write to sms_queue log:', logErr.message)

  if (status === 'Error') throw new Error(errorMessage || 'Failed to send SMS')
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

  // E5-04 Option B: one shared webhook endpoint, multiple organisations'
  // Stripe accounts. Signature verification must succeed BEFORE the payload
  // can be parsed to learn which booking (and therefore which organisation)
  // an event is about, and Stripe posts every event to the one webhook URL
  // registered for this deployment - so instead of loading one
  // pre-selected organisation's secret, every organisation's registered
  // webhook secret is a CANDIDATE, and whichever one actually verifies the
  // signature is what identifies the organisation. The unverified payload
  // itself is never consulted to select an organisation - only a
  // successful HMAC match does that. Deliberately selects only the two
  // webhook-secret keys here, not the API secret keys (stripe_secret_key_*)
  // - those are loaded afterwards, only for the one matched organisation.
  const { data: candidateRows, error: candidateErr } = await supabaseAdmin
    .from('settings')
    .select('org_id, key, value')
    .in('key', ['stripe_webhook_secret_test', 'stripe_webhook_secret_live'])

  if (candidateErr) {
    console.error('Failed to load candidate webhook secrets:', candidateErr.message)
    return new Response(JSON.stringify({ error: candidateErr.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const candidates: { orgId: string; mode: StripeMode; secret: string }[] = (candidateRows || [])
    .filter((row: any) => row.value && String(row.value).trim() !== '')
    .map((row: any) => ({
      orgId: row.org_id as string,
      mode: (row.key === 'stripe_webhook_secret_test' ? 'test' : 'live') as StripeMode,
      secret: row.value as string,
    }))

  // Instantiated purely to reach the .webhooks namespace — the API key
  // itself plays no role in signature verification, which depends only on
  // the raw payload, the signature header, and the webhook signing secret.
  const stripeForVerification = new Stripe('sk_unused_placeholder', {
    apiVersion: '2024-06-20', httpClient: Stripe.createFetchHttpClient()
  })
  const cryptoProvider = Stripe.createSubtleCryptoProvider()

  // Try EVERY candidate - deliberately do NOT stop at the first success.
  // Stripe's HMAC scheme ties a given (payload, signature) pair to exactly
  // the secret that produced it, so more than one candidate verifying the
  // same signature can only happen if two candidates share an identical
  // secret value - including, e.g., the SAME organisation's own test and
  // live secrets accidentally being set to the same value. Collecting every
  // match (not just the first) is what makes that detectable at all.
  const matches: { orgId: string; mode: StripeMode; event: any }[] = []
  for (const candidate of candidates) {
    try {
      const verifiedEvent = await stripeForVerification.webhooks.constructEventAsync(
        rawBody, signature, candidate.secret, undefined, cryptoProvider
      )
      matches.push({ orgId: candidate.orgId, mode: candidate.mode, event: verifiedEvent })
    } catch (_e) {
      // Wrong secret for this event - try the next candidate.
    }
  }

  if (matches.length === 0) {
    return new Response(JSON.stringify({ error: 'Webhook signature verification failed.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  if (matches.length > 1) {
    // Ambiguous by full (org_id, mode) identity, not collapsed to org_id -
    // Org A's own test+live pair sharing a secret is exactly as ambiguous
    // as two different organisations sharing one. Refusing to guess here
    // is the whole point: an arbitrarily-chosen match could silently
    // confirm a real payment under the wrong organisation. Never logs the
    // secret itself, only which (org, mode) pairs collided.
    const candidateDescriptor = matches.map((m) => `${m.orgId}/${m.mode}`).join(', ')
    console.error(`stripe-webhook: signature verified against ${matches.length} distinct org+mode candidates (${candidateDescriptor}) - refusing to guess which organisation this event belongs to. Two webhook secrets are identical; regenerate one of them in its Stripe dashboard.`)
    await captureAndFlush(
      new Error('stripe-webhook: ambiguous signature match across multiple org+mode candidates'),
      'stripe-webhook',
      { candidateCount: String(matches.length), candidates: candidateDescriptor }
    )
    return new Response(JSON.stringify({ error: 'Webhook configuration is ambiguous and cannot be safely processed.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const { orgId: matchedOrgId, mode: verifiedMode, event } = matches[0]

  // Reload the MATCHED organisation's full Stripe settings (API secret keys
  // included) now that verification has established which org this event
  // actually belongs to - the candidate list above deliberately only ever
  // carried webhook secrets, never API keys, for exactly this organisation
  // that turned out to be the wrong one until just now.
  let stripeSettings
  try {
    stripeSettings = await loadStripeSettings(supabaseAdmin, matchedOrgId)
  } catch (e: any) {
    console.error('Failed to load Stripe settings for matched organisation:', e.message)
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
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
          // E5-04 Option B cross-check: the booking this event claims to be
          // about must belong to the SAME organisation whose secret verified
          // it. A mismatch can't be fixed by Stripe retrying the identical
          // delivery, so this is acknowledged (not a 4xx/5xx that would make
          // Stripe retry forever) - same "verified but not actionable"
          // shape as the missing-bookingId case just above - but alerted via
          // Sentry, unlike that routine case, since a mismatch here is a
          // real, investigable inconsistency rather than a stray/old event.
          const { data: bookingOrgRow } = await supabaseAdmin
            .from('bookings')
            .select('org_id')
            .eq('id', bookingId)
            .maybeSingle()

          if (bookingOrgRow && bookingOrgRow.org_id !== matchedOrgId) {
            console.warn(`checkout.session.completed (event ${event.id}) verified against org ${matchedOrgId} but booking ${bookingId} belongs to org ${bookingOrgRow.org_id} - acknowledging without action.`)
            await captureAndFlush(
              new Error('stripe-webhook: booking organisation does not match the verified webhook organisation'),
              'stripe-webhook',
              { matchedOrgId, bookingOrgId: bookingOrgRow.org_id, bookingId }
            )
            return new Response(JSON.stringify({ received: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })
          }

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

            // Independent of the email above (its own try/catch) so an SMS
            // failure never masks — or is masked by — the email outcome.
            try {
              await sendConfirmationSms(supabaseAdmin, bookingId)
            } catch (smsErr: any) {
              console.warn('Failed to send booking_confirmed SMS after Stripe payment:', smsErr.message)
            }
          }
        }
      }
    } else if (event.type === 'charge.refunded') {
      // Reconciliation, not initiation: this fires for refunds issued in the
      // Stripe dashboard AND for ones the refund-payment function issued via
      // the API. Handling it is what closes the "admin refunds in Stripe, the
      // app never finds out" hole — the exact failure mode a record-only
      // refund flow is vulnerable to.
      const charge = event.data.object
      const paymentIntentId: string | null = typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : (charge.payment_intent?.id || null)

      if (!paymentIntentId) {
        console.warn(`charge.refunded (event ${event.id}) has no payment_intent — cannot map it to a booking, acknowledging without action.`)
      } else {
        // The booking is found by the payment intent recorded when the
        // payment succeeded, which is the only durable link between a Stripe
        // charge and a booking here (charge metadata isn't guaranteed to
        // carry booking_id, since the refund may be created in the dashboard
        // rather than by our own API call).
        const { data: booking, error: lookupErr } = await supabaseAdmin
          .from('bookings')
          .select('id, org_id')
          .eq('stripe_payment_intent_id', paymentIntentId)
          .maybeSingle()

        if (lookupErr) throw new Error('Failed to look up booking by payment intent: ' + lookupErr.message)

        if (!booking) {
          console.warn(`charge.refunded (event ${event.id}) for payment_intent ${paymentIntentId} matched no booking — acknowledging without action.`)
        } else if (booking.org_id !== matchedOrgId) {
          // E5-04 Option B cross-check - same reasoning as the
          // checkout.session.completed branch above: acknowledge rather than
          // trigger a Stripe retry loop for something retrying can't fix,
          // but alert via Sentry since this is a real inconsistency to
          // investigate, not routine missing data.
          console.warn(`charge.refunded (event ${event.id}) verified against org ${matchedOrgId} but booking ${booking.id} belongs to org ${booking.org_id} - acknowledging without action.`)
          await captureAndFlush(
            new Error('stripe-webhook: booking organisation does not match the verified webhook organisation'),
            'stripe-webhook',
            { matchedOrgId, bookingOrgId: booking.org_id, bookingId: booking.id }
          )
        } else {
          // Stripe reports amounts in the smallest currency unit (pence);
          // stall_cost and refund_amount are in pounds.
          const refundedAmount = (charge.amount_refunded ?? 0) / 100

          // Getting the actual refund id (re_...) takes an API call, because
          // the event does not carry one. `charge.refunds` is ABSENT from the
          // charge.refunded payload on current API versions (verified live on
          // 2026-07-21 against 2026-06-24.dahlia: no `refunds`, no
          // `latest_refund`), so the previous `charge.refunds?.data?.[0]?.id
          // || charge.id` was not a defensive fallback — the `|| charge.id`
          // branch was the ONLY one that ever ran, and every dashboard refund
          // recorded a CHARGE id in a column documented to hold a refund id.
          //
          // The embedded list is still checked first so that an API version
          // which does include it costs no extra round trip. charge.id remains
          // the last resort: recording a refund against a slightly weaker
          // reference is far better than failing the webhook and leaving the
          // refund unrecorded entirely, which is the hole this handler exists
          // to close.
          let refundId: string = charge.refunds?.data?.[0]?.id || ''
          if (!refundId) {
            try {
              const stripeApi = getStripeClient(verifiedMode, stripeSettings)
              const refunds = await stripeApi.refunds.list({ charge: charge.id, limit: 1 })
              refundId = refunds.data?.[0]?.id || ''
            } catch (e: any) {
              console.warn(`charge.refunded (event ${event.id}): could not look up the refund id for charge ${charge.id}, falling back to the charge id:`, e?.message)
            }
          }
          if (!refundId) refundId = charge.id

          const { error: refundErr } = await supabaseAdmin.rpc('rpc_record_refund', {
            p_booking_id: booking.id,
            p_refund_amount: refundedAmount,
            p_refund_reference: refundId,
            p_notes: `Recorded automatically from Stripe ${event.type} (event ${event.id}).`,
            // No auth.uid() on a service_role call, so the RPC honours this
            // attribution — mirrors the 'Stripe (automatic)' convention the
            // payments.editor column already uses for automated payments.
            p_refunded_by: 'Stripe (automatic)'
          })

          if (refundErr) {
            // Already-refunded is the EXPECTED path when refund-payment
            // initiated this refund itself: that function records the refund
            // synchronously, then Stripe delivers this webhook moments later
            // for the same refund. Treating that as an error would make every
            // API-initiated refund log a spurious failure and return 500,
            // which would make Stripe retry it indefinitely.
            if (/already been refunded/i.test(refundErr.message)) {
              console.log(`charge.refunded (event ${event.id}): booking ${booking.id} already has this refund recorded — nothing to do.`)
            } else {
              throw new Error('rpc_record_refund failed: ' + refundErr.message)
            }
          } else {
            console.log(`Recorded refund of ${refundedAmount} for booking ${booking.id} from Stripe event ${event.id}.`)
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
    await captureAndFlush(error, 'stripe-webhook')
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})
