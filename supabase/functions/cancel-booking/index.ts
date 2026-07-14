import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendViaZoho } from '../_shared/zoho.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

// Mirrors js/utils.js's escapeHtml() exactly.
function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
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
    .select('email, owner_name, business_name, instance_prefix, rejection_reason')
    .eq('id', bookingId)
    .single()

  if (bookingErr || !booking?.email) {
    throw new Error('Could not load booking for cancellation email: ' + (bookingErr?.message || 'not found'))
  }

  const { data: templateData, error: templateErr } = await supabaseAdmin
    .from('email_templates')
    .select('subject, body_html')
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
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { token, cancelToken, reason } = await req.json()

    if (!token) {
      return new Response(JSON.stringify({ error: 'Please complete the CAPTCHA verification.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!cancelToken) {
      return new Response(JSON.stringify({ error: 'Missing cancellation token.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 1. Verify Turnstile CAPTCHA with Cloudflare siteverify API
    const turnstileSecret = Deno.env.get('TURNSTILE_SECRET_KEY')
    if (!turnstileSecret) {
      throw new Error('TURNSTILE_SECRET_KEY is not configured on the server.')
    }

    const verifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
    const formData = new URLSearchParams()
    formData.append('secret', turnstileSecret)
    formData.append('response', token)

    const verifyResponse = await fetch(verifyUrl, {
      method: 'POST',
      body: formData
    })

    const verifyData = await verifyResponse.json()
    if (!verifyData.success) {
      return new Response(JSON.stringify({ error: 'CAPTCHA verification failed. Please try again.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

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
    }

    return new Response(JSON.stringify({ success: true, data }), {
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
