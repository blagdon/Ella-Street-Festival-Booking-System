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

const MAX_FIELD_LENGTHS: Record<string, number> = {
  business_name: 128,
  registered_business_name: 128,
  owner_name: 64,
  email: 254,
  phone: 30,
  address: 256,
  description: 500,
  other_requirements: 500,
  category: 200,
  docs_checklist: 500,
  is_charity: 30,
  power_required: 60,
}

const VALID_STALL_TYPES = ['Food', 'Non-Food']

function sanitizeString(val: unknown, maxLen: number): string {
  const str = (val === null || val === undefined) ? '' : String(val).trim()
  return str.length > maxLen ? str.slice(0, maxLen) : str
}

/**
 * Builds a safe booking row from raw, untrusted client input via an explicit
 * allow-list rather than inserting the request body as-is. This endpoint is
 * public and unauthenticated (Turnstile only proves a human made *a*
 * request, not that its JSON body matches what the form's own JS would have
 * sent) and runs under the service role, which bypasses RLS entirely — so
 * without this, a caller could set fields the UI never exposes (stall_cost,
 * admin_notes, date_confirmed, cancel_token, status, etc.) directly.
 */
function sanitizeBookingInput(raw: Record<string, any>, bookingPrefix: string): Record<string, any> {
  const instancePrefix = String(raw.instance_prefix || '')
  const validPrefixes = [`${bookingPrefix}-FOOD-`, `${bookingPrefix}-NONFOOD-`, `${bookingPrefix}-DEV-`]
  if (!validPrefixes.includes(instancePrefix)) {
    throw new Error('Invalid instance_prefix.')
  }

  const stallType = String(raw.stall_type || '')
  if (!VALID_STALL_TYPES.includes(stallType)) {
    throw new Error('Invalid stall_type.')
  }

  return {
    instance_prefix: instancePrefix,
    stall_type: stallType,
    business_name: sanitizeString(raw.business_name, MAX_FIELD_LENGTHS.business_name),
    registered_business_name: sanitizeString(raw.registered_business_name, MAX_FIELD_LENGTHS.registered_business_name),
    owner_name: sanitizeString(raw.owner_name, MAX_FIELD_LENGTHS.owner_name),
    email: sanitizeString(raw.email, MAX_FIELD_LENGTHS.email),
    phone: sanitizeString(raw.phone, MAX_FIELD_LENGTHS.phone),
    address: sanitizeString(raw.address, MAX_FIELD_LENGTHS.address),
    description: sanitizeString(raw.description, MAX_FIELD_LENGTHS.description),
    other_requirements: sanitizeString(raw.other_requirements, MAX_FIELD_LENGTHS.other_requirements),
    category: sanitizeString(raw.category, MAX_FIELD_LENGTHS.category),
    docs_checklist: sanitizeString(raw.docs_checklist, MAX_FIELD_LENGTHS.docs_checklist),
    is_charity: sanitizeString(raw.is_charity, MAX_FIELD_LENGTHS.is_charity),
    is_resident: raw.is_resident === true,
    power_required: sanitizeString(raw.power_required, MAX_FIELD_LENGTHS.power_required),
  }
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

    // 3. Build a safe row from an explicit allow-list — never insert the
    // raw request body (see sanitizeBookingInput's docstring).
    const { data: prefixSetting } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('key', 'booking_prefix')
      .single()
    const bookingPrefix = prefixSetting?.value || 'ESF26'

    const safeBookingData = sanitizeBookingInput(bookingData, bookingPrefix)

    // 4. Atomically generate the next sequential ID
    const { data: newBookingId, error: rpcErr } = await supabaseAdmin.rpc('get_next_booking_id', {
      p_prefix: safeBookingData.instance_prefix
    })

    if (rpcErr || !newBookingId) {
      throw new Error('Failed to generate Booking ID: ' + (rpcErr?.message || 'Empty ID returned.'))
    }

    safeBookingData.id = newBookingId
    safeBookingData.status = 'Pending'

    // 5. Move files from temporary location to final folder in Storage
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

      safeBookingData.documents = movedUrls
    }

    // 6. Insert booking into database
    const { data, error } = await supabaseAdmin.from('bookings').insert([safeBookingData]).select()
    if (error) throw error

    // 7. Send the "received" auto-responder. Best-effort: a failure here must
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
