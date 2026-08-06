import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendViaZoho } from '../_shared/zoho.ts'
import { sendViaSms, normalizePhone } from '../_shared/sms.ts'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'
import { escapeHtml } from '../_shared/format.ts'
import { publicErrorResponse } from '../_shared/errors.ts'
import { verifyTurnstile } from '../_shared/turnstile.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

/**
 * Sends the cancellation-confirmation email and logs the attempt to
 * email_queue (same send-then-log pattern as submit-booking's
 * sendReceivedEmail()). This used to be a DB trigger (handle_cancel_email)
 * that only ever inserted an email_queue row with status='Pending' — since
 * nothing in this app polls that table for pending rows, cancellation
 * emails were silently never sent. Moved here so it's actually dispatched.
 * Calls sendViaZoho() directly (in-process) rather than invoking send-email
 * as a separate Edge Function over HTTP, for the same reason queue-bulk-email
 * does — see _shared/zoho.ts's docstring for the sibling-function HTTP
 * failure mode this avoids.
 * Best-effort: throws are caught by the caller so a failure here can't
 * undo an already-successful cancellation.
 */
async function sendCancellationEmail(supabaseAdmin: ReturnType<typeof createClient>, bookingId: string) {
  const { data: booking, error: bookingErr } = await supabaseAdmin
    .from('bookings')
    .select('org_id, email, owner_name, business_name, instance_prefix, rejection_reason')
    .eq('id', bookingId)
    .single()

  if (bookingErr || !booking?.email) {
    throw new Error('Could not load booking for cancellation email: ' + (bookingErr?.message || 'not found'))
  }

  const { data: templateData, error: templateErr } = await supabaseAdmin
    .from('email_templates')
    .select('subject, body_html')
    .eq('org_id', booking.org_id)
    .eq('id', 'cancellation_confirmed')
    .single()

  if (templateErr || !templateData) {
    throw new Error('Could not load "cancellation_confirmed" email template: ' + (templateErr?.message || 'not found'))
  }

  const replaceVars = (str: string) =>
    (str || '')
      .replace(/\{\{owner_name\}\}/g, escapeHtml(booking.owner_name || 'Trader'))
      .replace(/\{\{business_name\}\}/g, escapeHtml(booking.business_name || 'your business'))
      .replace(/\{\{booking_id\}\}/g, bookingId || '')
      .replace(/\{\{reason\}\}/g, escapeHtml(booking.rejection_reason || ''))
      // Not relevant to a cancellation confirmation — blank rather than
      // leaking a raw {{placeholder}} into the email.
      .replace(/\{\{cancel_link\}\}/g, '')
      .replace(/\{\{cost\}\}/g, '')
      .replace(/\{\{bank_details\}\}/g, '')
      .replace(/\{\{location_id\}\}/g, '')

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
 * Sends the cancellation-confirmation text, mirroring sendCancellationEmail's
 * shape but reusing the existing "booking_cancelled" sms_templates row — the
 * same one an admin's own Cancel-modal tickbox already sends. No opt-in
 * tickbox here: self-service cancellation is public/unauthenticated, so
 * there's no admin present to tick anything — fires automatically whenever
 * the booking has a phone number, the same "no admin present" reasoning as
 * submit-booking's sendReceivedSms. Reported live as a gap: whenever an
 * email is sent, there should be a corresponding SMS option, and this path
 * (a stallholder cancelling their own booking) had none at all.
 * Best-effort: throws are caught by the caller, same contract as
 * sendCancellationEmail.
 */
async function sendCancellationSms(supabaseAdmin: ReturnType<typeof createClient>, bookingId: string) {
  const { data: booking, error: bookingErr } = await supabaseAdmin
    .from('bookings')
    .select('org_id, phone, owner_name, business_name, instance_prefix')
    .eq('id', bookingId)
    .single()

  if (bookingErr || !booking) {
    throw new Error('Could not load booking for cancellation SMS: ' + (bookingErr?.message || 'not found'))
  }
  if (!booking.phone) return

  const { data: templateData, error: templateErr } = await supabaseAdmin
    .from('sms_templates')
    .select('body')
    .eq('org_id', booking.org_id)
    .eq('id', 'booking_cancelled')
    .single()

  if (templateErr || !templateData) {
    throw new Error('Could not load "booking_cancelled" SMS template: ' + (templateErr?.message || 'not found'))
  }

  const body = templateData.body
    .replace(/\{\{owner_name\}\}/g, booking.owner_name || 'Trader')
    .replace(/\{\{business_name\}\}/g, booking.business_name || 'your business')
    .replace(/\{\{booking_id\}\}/g, bookingId || '')

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
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { token, cancelToken, reason } = await req.json()

    if (!cancelToken) {
      return new Response(JSON.stringify({ error: 'Missing cancellation token.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 1. Verify Turnstile CAPTCHA with Cloudflare siteverify API
    await verifyTurnstile(token)

    // 2. Initialize Supabase client with Service Role Key
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Call the database function to cancel the booking
    const { data, error } = await supabaseClient.rpc('cancel_booking_secure', {
      p_token: cancelToken,
      p_reason: reason || null
    })

    if (error || (data && data.success === false)) {
      const errMsg = (data && data.error) ? data.error : 'Could not cancel. The link may have already been used or has expired.'
      return new Response(JSON.stringify({ error: errMsg }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (data?.booking_id) {
      try {
        await sendCancellationEmail(supabaseClient, data.booking_id)
      } catch (emailErr: any) {
        console.warn('Failed to send cancellation confirmation email:', emailErr.message)
      }

      // Independent of the email above (its own try/catch) so an SMS
      // failure never masks — or is masked by — the email outcome.
      try {
        await sendCancellationSms(supabaseClient, data.booking_id)
      } catch (smsErr: any) {
        console.warn('Failed to send cancellation confirmation SMS:', smsErr.message)
      }
    }

    return new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error: any) {
    // The validation paths above already return their own safe messages
    // directly; this only catches the unexpected. See _shared/errors.ts.
    return publicErrorResponse(error, 'cancel-booking', corsHeaders)
  }
})
