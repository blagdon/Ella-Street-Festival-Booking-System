import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getBucketName } from '../_shared/bucket.ts'
import { sendViaZoho } from '../_shared/zoho.ts'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'
import { escapeHtml } from '../_shared/format.ts'
import { PublicError, publicErrorResponse } from '../_shared/errors.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

const MAX_FIELD_LENGTHS: Record<string, number> = {
  business_name: 128,
  registered_business_name: 128,
  owner_name: 64,
  email: 254,
  phone: 30,
  address: 256,
  website: 256,
  description: 500,
  other_requirements: 500,
  category: 200,
  docs_checklist: 500,
  power_required: 60,
}

const VALID_STALL_TYPES = ['Food', 'Non-Food']

// Matches what the client always sends: tempUuid is crypto.randomUUID()
// (or a non-crypto fallback for older browsers), and each fileName is
// already sanitized client-side (file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_'))
// before upload. Re-validated here since this endpoint is public and the
// client-side sanitization is trivially bypassable by calling it directly —
// storage keys built from these values must never be trusted verbatim.
const SAFE_TEMP_UUID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/
const SAFE_FILENAME_PATTERN = /^[a-zA-Z0-9.\-_]{1,255}$/

function sanitizeString(val: unknown, maxLen: number): string {
  const str = (val === null || val === undefined) ? '' : String(val).trim()
  return str.length > maxLen ? str.slice(0, maxLen) : str
}

// is_charity is a fixed tri-state (Postgres enum booking_fee_type), not
// free text — matches the fallback already used everywhere else this
// value is read (js/api.js, js/details.js, js/shared.js all do
// `x.is_charity || 'Commercial'`). Unlike sanitizeString, this rejects any
// value outside the three real labels rather than storing it verbatim —
// a blank/missing selection on the public form used to silently become an
// empty string (harmless only because every read site already defaulted
// falsy values back to 'Commercial'); now that the column is a real enum,
// storing '' outright fails the insert instead of being silently masked.
const VALID_CHARITY_STATUSES = ['Commercial', 'Charity', 'Not for profit']
function sanitizeCharityStatus(val: unknown): string {
  return VALID_CHARITY_STATUSES.includes(val as string) ? (val as string) : 'Commercial'
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
    throw new PublicError('Invalid instance_prefix.')
  }

  const stallType = String(raw.stall_type || '')
  if (!VALID_STALL_TYPES.includes(stallType)) {
    throw new PublicError('Invalid stall_type.')
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
    website: sanitizeString(raw.website, MAX_FIELD_LENGTHS.website),
    description: sanitizeString(raw.description, MAX_FIELD_LENGTHS.description),
    other_requirements: sanitizeString(raw.other_requirements, MAX_FIELD_LENGTHS.other_requirements),
    category: sanitizeString(raw.category, MAX_FIELD_LENGTHS.category),
    docs_checklist: sanitizeString(raw.docs_checklist, MAX_FIELD_LENGTHS.docs_checklist),
    is_charity: sanitizeCharityStatus(raw.is_charity),
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
 * Calls sendViaZoho() directly (in-process) rather than invoking send-email
 * as a separate Edge Function over HTTP, for the same reason
 * queue-bulk-email and cancel-booking do — see _shared/zoho.ts's docstring
 * for the sibling-function HTTP failure mode this avoids.
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
    safeBookingData.status = 'Pending'

    // 4. Atomically generate the next sequential ID and insert the row.
    // get_next_booking_id()'s table lock only covers that single RPC call —
    // it's released before this insert runs, so two concurrent submissions
    // to the same instance_prefix can still compute the same "next" id
    // before either has inserted. Confirmed live via a real concurrency
    // integration test (two simultaneous submissions, one got a raw
    // "duplicate key value violates unique constraint bookings_pkey" 500).
    // Rather than trying to fully close that race with a wider lock (which
    // would need to span this insert too, awkward across a separate RPC
    // call), retry with a freshly generated id on conflict — a successful
    // insert is the actual proof of a claimed id.
    const MAX_ID_RETRIES = 5
    let newBooking: any = null
    let lastInsertErr: any = null

    for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt++) {
      const { data: newBookingId, error: rpcErr } = await supabaseAdmin.rpc('get_next_booking_id', {
        p_prefix: safeBookingData.instance_prefix
      })
      if (rpcErr || !newBookingId) {
        throw new Error('Failed to generate Booking ID: ' + (rpcErr?.message || 'Empty ID returned.'))
      }

      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from('bookings')
        .insert([{ ...safeBookingData, id: newBookingId }])
        .select()

      if (!insertErr) {
        newBooking = inserted[0]
        break
      }

      // 23505 = unique_violation — another concurrent submission claimed
      // this id first. Retry with a freshly generated one.
      if (insertErr.code === '23505') {
        lastInsertErr = insertErr
        continue
      }
      throw insertErr
    }

    if (!newBooking) {
      throw new Error(
        'Failed to create booking after retrying a booking-ID conflict ' +
        MAX_ID_RETRIES + ' times: ' + (lastInsertErr?.message || 'unknown error')
      )
    }

    // 5. Move files from temporary location into the now-confirmed
    // booking's folder, then record their storage paths on the row. Done
    // after the insert (not before) since the booking's real id isn't
    // settled until the insert above actually succeeds.
    if (tempUuid && fileNames && Array.isArray(fileNames) && fileNames.length > 0) {
      if (!SAFE_TEMP_UUID_PATTERN.test(tempUuid)) {
        throw new PublicError('Invalid upload session identifier.')
      }
      for (const fileName of fileNames) {
        if (typeof fileName !== 'string' || !SAFE_FILENAME_PATTERN.test(fileName)) {
          throw new PublicError('Invalid file name in upload list.')
        }
      }

      const bucketName = await getBucketName(supabaseAdmin)
      const movedPaths = []

      for (const fileName of fileNames) {
        const fromPath = `temp/${tempUuid}/${fileName}`
        const toPath = `${newBooking.id}/${fileName}`

        // Store the storage path, not a public URL — esf-documents is a
        // private bucket; admin views resolve this to a signed URL on
        // demand via the get-booking-documents Edge Function. If the move
        // fails, keep the temp path instead of recording a destination that
        // doesn't exist: nothing cleans up temp/, so the uploaded file is
        // still there and signable — the admin just sees it under its temp
        // path rather than the booking's folder.
        const { error: moveErr } = await supabaseAdmin.storage.from(bucketName).move(fromPath, toPath)
        if (moveErr) {
          console.warn(`Failed to move file ${fromPath} to ${toPath} (keeping temp path):`, moveErr.message)
          movedPaths.push(fromPath)
        } else {
          movedPaths.push(toPath)
        }
      }

      const { error: updateErr } = await supabaseAdmin
        .from('bookings')
        .update({ documents: movedPaths })
        .eq('id', newBooking.id)
      if (updateErr) console.warn('Failed to record document paths:', updateErr.message)
      newBooking.documents = movedPaths
    }

    const data = [newBooking]

    // 6. Send the "received" auto-responder. Best-effort: a failure here must
    // never fail the booking submission itself (the booking already exists).
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
    // Only PublicError messages reach the caller; everything else (Postgres
    // errors, RPC failures, missing server config) is logged in full and
    // replaced with a generic message. See _shared/errors.ts.
    return publicErrorResponse(error, 'submit-booking', corsHeaders)
  }
})
