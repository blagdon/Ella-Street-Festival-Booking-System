import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendViaSms, normalizePhone } from '../_shared/sms.ts'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'
import { captureAndFlush } from '../_shared/sentry.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MAX_RECIPIENTS = 2000
const MAX_BODY_LEN = 1600
// Safety cap on how many 50-row batches a single invocation will drain, same
// bound as queue-bulk-email.
const MAX_DRAIN_BATCHES = 50

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Bulk SMS, the SMS twin of queue-bulk-email. Re-derives recipients
 * server-side from Confirmed bookings (never trusts client-supplied numbers),
 * normalises each to E.164, queues them, and drains sms_queue in the
 * background via EdgeRuntime.waitUntil so the send survives the admin closing
 * their browser. Calls sendViaSms() in-process (no sibling-function HTTP hop)
 * for the same reason the email path calls sendViaZoho directly.
 *
 * COST NOTE: unlike email, every message here is billed. Recipient derivation
 * is capped at MAX_RECIPIENTS and the caller (viewer) should confirm the count
 * before invoking.
 */
async function sendOneSms(
  supabaseAdmin: ReturnType<typeof createClient>,
  row: { recipient: string; body: string }
): Promise<{ status: string; errorMessage: string | null; providerMessageId: string | null; segments: number | null }> {
  const MAX_ATTEMPTS = 2
  let lastErrorMessage = 'Unknown error'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await sendViaSms(supabaseAdmin, { recipient: row.recipient, body: row.body })
      return { status: 'Sent', errorMessage: null, providerMessageId: result.providerMessageId, segments: result.segments }
    } catch (e: any) {
      lastErrorMessage = e.message
      if (attempt < MAX_ATTEMPTS) await sleep(300)
    }
  }

  return { status: 'Error', errorMessage: lastErrorMessage + ` (after ${MAX_ATTEMPTS} attempts)`, providerMessageId: null, segments: null }
}

async function drainPendingSms(supabaseAdmin: ReturnType<typeof createClient>) {
  for (let i = 0; i < MAX_DRAIN_BATCHES; i++) {
    const { data: batch, error: claimErr } = await supabaseAdmin.rpc('claim_pending_sms', { p_batch_size: 50 })
    if (claimErr) {
      console.error('claim_pending_sms failed:', claimErr.message)
      return
    }
    if (!batch || batch.length === 0) return

    for (const row of batch) {
      const { status, errorMessage, providerMessageId, segments } = await sendOneSms(supabaseAdmin, row)

      const { error: updateErr } = await supabaseAdmin
        .from('sms_queue')
        .update({ status, error_message: errorMessage, provider_message_id: providerMessageId, segments })
        .eq('id', row.id)
      if (updateErr) console.warn(`Failed to update sms_queue row ${row.id}:`, updateErr.message)

      // Courteous pacing between sequential provider sends.
      await sleep(100)
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Admin-only — this queues real, billed outbound texts to real people.
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

    const { bookingIds, body } = await req.json()

    if (!Array.isArray(bookingIds) || bookingIds.length === 0) {
      return new Response(JSON.stringify({ error: 'bookingIds must be a non-empty array.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    if (bookingIds.length > MAX_RECIPIENTS) {
      return new Response(JSON.stringify({ error: `Too many recipients (max ${MAX_RECIPIENTS}).` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    if (!body || typeof body !== 'string' || body.length > MAX_BODY_LEN) {
      return new Response(JSON.stringify({ error: `Invalid or missing body (max ${MAX_BODY_LEN} chars).` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Re-derive recipients server-side — only Confirmed bookings with a phone.
    const { data: bookings, error: bookingsErr } = await supabaseClient
      .from('bookings')
      .select('id, phone, instance_prefix')
      .in('id', bookingIds)
      .eq('status', 'Confirmed')

    if (bookingsErr) {
      throw new Error('Failed to look up bookings: ' + bookingsErr.message)
    }

    // Normalise each number; silently skip ones we can't turn into E.164 rather
    // than failing the whole batch, but report how many were skipped so the
    // admin knows the queued count is lower than the selection.
    const rows: Array<Record<string, any>> = []
    let skipped = 0
    for (const b of bookings || []) {
      if (!b.phone) { skipped++; continue }
      try {
        rows.push({
          recipient: normalizePhone(b.phone),
          body,
          status: 'Pending',
          instance_prefix: b.instance_prefix || null,
        })
      } catch {
        skipped++
      }
    }

    if (rows.length === 0) {
      return new Response(JSON.stringify({ error: 'None of the supplied bookings are Confirmed with a valid phone number.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { error: insertErr } = await supabaseClient.from('sms_queue').insert(rows)
    if (insertErr) {
      throw new Error('Failed to queue texts: ' + insertErr.message)
    }

    // @ts-ignore — EdgeRuntime is a Deno Deploy global, not in the TS lib defs.
    if (typeof EdgeRuntime !== 'undefined') {
      // @ts-ignore
      EdgeRuntime.waitUntil(drainPendingSms(supabaseClient))
    } else {
      drainPendingSms(supabaseClient)
    }

    return new Response(JSON.stringify({ queued: rows.length, skipped }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (error: any) {
    await captureAndFlush(error, 'queue-bulk-sms')
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
