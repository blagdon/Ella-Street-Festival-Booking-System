import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

// Mirrors js/utils.js's escapeHtml() exactly — user-supplied booking fields
// (owner_name, business_name) must never be substituted into email HTML
// unescaped.
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
 * Sends the "received" auto-responder for a newly submitted booking, and
 * logs the attempt to email_queue (mirrors js/api.js's sendEmailDirect()
 * client-side pattern, minus the resend-specific bits). Throws on failure
 * so the caller can decide how to log/ignore it — this function never
 * touches the bookings row itself, so a failure here can't corrupt data.
 */
async function sendReceivedEmail(supabaseAdmin: ReturnType<typeof createClient>, booking: Record<string, any>) {
  const [{ data: templateData, error: templateErr }, { data: settingRows }] = await Promise.all([
    supabaseAdmin.from('email_templates').select('subject, body_html').eq('id', 'application_received').single(),
    supabaseAdmin.from('settings').select('key, value').eq('key', 'cancel_url')
  ])

  if (templateErr || !templateData) {
    throw new Error('Could not load "received" email template: ' + (templateErr?.message || 'not found'))
  }

  const cancelUrl = settingRows?.[0]?.value || ''
  const cancelLink = (cancelUrl && booking.cancel_token)
    ? `${cancelUrl}?token=${encodeURIComponent(booking.cancel_token)}`
    : cancelUrl

  const replaceVars = (str: string) =>
    (str || '')
      .replace(/\{\{owner_name\}\}/g, escapeHtml(booking.owner_name || 'Trader'))
      .replace(/\{\{business_name\}\}/g, escapeHtml(booking.business_name || 'your business'))
      .replace(/\{\{booking_id\}\}/g, booking.id || '')
      .replace(/\{\{cancel_link\}\}/g, cancelLink)
      // Not relevant at submission time (no cost/location assigned yet) —
      // blank rather than leaking a raw {{placeholder}} into the email.
      .replace(/\{\{cost\}\}/g, '')
      .replace(/\{\{bank_details\}\}/g, '')
      .replace(/\{\{location_id\}\}/g, '')
      .replace(/\{\{reason\}\}/g, '')

  const subject = replaceVars(templateData.subject)
  const body = replaceVars(templateData.body_html)

  let status = 'Sent'
  let errorMessage: string | null = null

  try {
    const { data: sendData, error: sendErr } = await supabaseAdmin.functions.invoke('send-email', {
      body: { recipient: booking.email, subject, body }
    })
    if (sendErr) throw new Error(sendErr.message)
    if (sendData && sendData.error) throw new Error(sendData.error)
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
    const { token, bookingData, tempUuid, fileNames } = await req.json()

    if (!token || !bookingData) {
      return new Response(JSON.stringify({ error: 'Missing CAPTCHA token or booking data.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 1. Verify Cloudflare Turnstile CAPTCHA
    const turnstileSecret = Deno.env.get('TURNSTILE_SECRET_KEY')
    if (!turnstileSecret) {
      throw new Error('TURNSTILE_SECRET_KEY is not configured on the server.')
    }

    const cfVerify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: turnstileSecret,
        response: token
      }),
    })
    
    const cfResponse = await cfVerify.json()
    if (!cfResponse.success) {
      const cfErrors = cfResponse['error-codes'] ? cfResponse['error-codes'].join(', ') : 'Unknown Cloudflare Error';
      return new Response(JSON.stringify({ 
        error: `CAPTCHA Rejected by Cloudflare. Reason: [${cfErrors}]` 
      }), { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      })
    }

    // 2. Initialize Supabase client with service role to bypass RLS for insertion
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 3. Atomically generate the next sequential ID
    const { data: newBookingId, error: rpcErr } = await supabaseAdmin.rpc('get_next_booking_id', {
      p_prefix: bookingData.instance_prefix
    })

    if (rpcErr || !newBookingId) {
      throw new Error('Failed to generate Booking ID: ' + (rpcErr?.message || 'Empty ID returned.'))
    }

    bookingData.id = newBookingId
    bookingData.status = 'Pending'

    // 4. Move files from temporary location to final folder in Storage
    if (tempUuid && fileNames && Array.isArray(fileNames) && fileNames.length > 0) {
      // Env var takes priority if set, otherwise fall back to the same
      // settings-table value the admin Settings page manages, so changing
      // the bucket there actually takes effect here too.
      let bucketName = Deno.env.get('BUCKET_NAME')
      if (!bucketName) {
        const { data: bucketSetting } = await supabaseAdmin
          .from('settings')
          .select('value')
          .eq('key', 'bucket_name')
          .single()
        bucketName = bucketSetting?.value || 'esf-documents'
      }
      const movedUrls = []

      for (const fileName of fileNames) {
        const fromPath = `temp/${tempUuid}/${fileName}`
        const toPath = `${newBookingId}/${fileName}`

        // Move the file
        const { error: moveErr } = await supabaseAdmin.storage.from(bucketName).move(fromPath, toPath)
        if (moveErr) {
          console.warn(`Failed to move file ${fromPath} to ${toPath}:`, moveErr.message)
          // Fallback: If move fails, try using the original temp URL if available
        }

        // Get final public URL
        const { data: urlData } = supabaseAdmin.storage.from(bucketName).getPublicUrl(toPath)
        movedUrls.push(urlData.publicUrl)
      }

      bookingData.documents = movedUrls
    }

    // 5. Insert booking into database
    const { data, error } = await supabaseAdmin.from('bookings').insert([bookingData]).select()
    if (error) throw error

    // 6. Send the "received" auto-responder. Best-effort: a failure here must
    // never fail the booking submission itself (the booking already exists).
    const newBooking = data?.[0]
    if (newBooking?.email) {
      try {
        await sendReceivedEmail(supabaseAdmin, newBooking)
      } catch (emailErr: any) {
        console.warn('Failed to send "received" auto-responder:', emailErr.message)
      }
    }

    return new Response(JSON.stringify({ success: true, data }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
