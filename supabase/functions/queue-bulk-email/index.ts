import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendViaZoho } from '../_shared/zoho.ts'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MAX_RECIPIENTS = 2000
const MAX_SUBJECT_LEN = 500
const MAX_BODY_LEN = 100000
// Safety cap on how many 50-row batches a single invocation will drain —
// bounds worst-case background work if email_queue somehow accumulates an
// unexpectedly large Pending backlog.
const MAX_DRAIN_BATCHES = 50

/**
 * Drains email_queue in the background, independent of the client
 * connection — this is what makes the bulk send survive the admin
 * closing their browser mid-operation. Called via EdgeRuntime.waitUntil()
 * after the response has already been sent, so it can keep running for
 * as long as the function's execution budget allows.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Calls sendViaZoho() directly (in-process) rather than invoking send-email
// as a separate Edge Function over HTTP. The HTTP-hop version of this
// intermittently failed with "Failed to send a request to the Edge
// Function" (a raw fetch-level failure, no response at all) even after
// retries, when firing 50+ sequential same-target function invocations in
// a row — calling the shared Zoho logic directly removes that entire class
// of failure since there's no sibling-function HTTP call to fail. A small
// retry remains for genuine Zoho-side transient errors (e.g. a timeout
// talking to Zoho itself), which is a different, much rarer failure mode.
async function sendOneEmail(
  supabaseAdmin: ReturnType<typeof createClient>,
  row: { recipient: string; subject: string; body: string }
): Promise<{ status: string; errorMessage: string | null }> {
  const MAX_ATTEMPTS = 2
  let lastErrorMessage = 'Unknown error'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await sendViaZoho(supabaseAdmin, { recipient: row.recipient, subject: row.subject, body: row.body })
      return { status: 'Sent', errorMessage: null }
    } catch (e: any) {
      lastErrorMessage = e.message
      if (attempt < MAX_ATTEMPTS) await sleep(300)
    }
  }

  return { status: 'Error', errorMessage: lastErrorMessage + ` (after ${MAX_ATTEMPTS} attempts)` }
}

async function drainPendingEmails(supabaseAdmin: ReturnType<typeof createClient>) {
  for (let i = 0; i < MAX_DRAIN_BATCHES; i++) {
    const { data: batch, error: claimErr } = await supabaseAdmin.rpc('claim_pending_emails', { p_batch_size: 50 })
    if (claimErr) {
      console.error('claim_pending_emails failed:', claimErr.message)
      return
    }
    if (!batch || batch.length === 0) return

    for (const row of batch) {
      const { status, errorMessage } = await sendOneEmail(supabaseAdmin, row)

      const { error: updateErr } = await supabaseAdmin
        .from('email_queue')
        .update({ status, error_message: errorMessage })
        .eq('id', row.id)
      if (updateErr) console.warn(`Failed to update email_queue row ${row.id}:`, updateErr.message)

      // Small pacing delay between sequential Zoho sends, courteous to
      // Zoho's own API rate limits.
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

    // Admin-only — this queues real outbound email to real recipients.
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

    const { bookingIds, subject, body } = await req.json()

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
    if (!subject || typeof subject !== 'string' || subject.length > MAX_SUBJECT_LEN) {
      return new Response(JSON.stringify({ error: 'Invalid or missing subject.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    if (!body || typeof body !== 'string' || body.length > MAX_BODY_LEN) {
      return new Response(JSON.stringify({ error: 'Invalid or missing body.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Re-derive recipients server-side rather than trusting client-supplied
    // emails — only actually-Confirmed bookings with a real email are used.
    const { data: bookings, error: bookingsErr } = await supabaseClient
      .from('bookings')
      .select('id, email, instance_prefix')
      .in('id', bookingIds)
      .eq('status', 'Confirmed')

    if (bookingsErr) {
      throw new Error('Failed to look up bookings: ' + bookingsErr.message)
    }

    const rows = (bookings || [])
      .filter((b) => !!b.email)
      .map((b) => ({
        recipient: b.email,
        subject,
        body,
        status: 'Pending',
        instance_prefix: b.instance_prefix || null
      }))

    if (rows.length === 0) {
      return new Response(JSON.stringify({ error: 'None of the supplied bookings are Confirmed with a valid email.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { error: insertErr } = await supabaseClient.from('email_queue').insert(rows)
    if (insertErr) {
      throw new Error('Failed to queue emails: ' + insertErr.message)
    }

    // @ts-ignore — EdgeRuntime is a Deno Deploy global, not in the TS lib defs.
    if (typeof EdgeRuntime !== 'undefined') {
      // @ts-ignore
      EdgeRuntime.waitUntil(drainPendingEmails(supabaseClient))
    } else {
      // Local dev fallback (no EdgeRuntime global) — fire and forget.
      drainPendingEmails(supabaseClient)
    }

    return new Response(JSON.stringify({ queued: rows.length }), {
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
