import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendViaZoho } from '../_shared/zoho.ts'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/**
 * Re-sends a single email_queue row that previously failed, for the Email
 * Queue viewer's "Retry" button.
 *
 * Why this needs to be an Edge Function at all: `authenticated` deliberately
 * has no UPDATE on email_queue (see the 20260718110000 grant-narrowing
 * migration) — status transitions are service-role/RPC only — and the Zoho
 * credentials are server-side. So the admin client can read the failed row
 * but can neither send nor mark the result; both happen here.
 *
 * Calls sendViaZoho() in-process rather than invoking send-email over HTTP,
 * same as queue-bulk-email/cancel-booking/submit-booking — see
 * _shared/zoho.ts's docstring for the sibling-function failure mode that
 * pattern avoids (and the pre-commit hook that enforces it).
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Admin JWT only — deliberately no service-role "trusted service call"
    // bypass (unlike send-email). Retrying is a human recovery action taken
    // from the viewer; nothing server-side should be triggering it.
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized: ' + authError?.message }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { data: roleData, error: roleError } = await supabaseAdmin
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

    const { id } = await req.json()
    if (!Number.isInteger(id)) {
      return new Response(JSON.stringify({ error: 'A numeric email_queue id is required.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Claim the row by flipping Error -> Processing conditionally, treating
    // "no rows updated" as the rejection. A separate SELECT-then-check would
    // leave a window where two callers both see 'Error' and both send;
    // Postgres serializes these conditional updates, so the loser re-evaluates
    // against the committed 'Processing' row and matches nothing.
    //
    // What this does and doesn't guarantee, precisely:
    //  - Two retries overlapping IN FLIGHT: only one sends. (The other gets
    //    409 while the first is still working.)
    //  - A retry after a previous one SUCCEEDED: refused, because the row is
    //    'Sent' and only 'Error' is claimable. This is the guarantee that
    //    matters — a delivered email is never delivered twice.
    //  - A retry after a previous one FAILED: allowed, because the row is
    //    back to 'Error'. That's intentional, not a hole: retrying a failure
    //    is the entire point of this endpoint.
    //
    // Pending/Processing rows are never claimable here — they belong to the
    // bulk-drain path.
    //
    // Note the crash-recovery interaction, which is intentional: if this
    // function dies between claiming and finishing, the row is left in
    // 'Processing' with claimed_at set, and claim_pending_emails()'s existing
    // 15-minute self-heal will hand it to the next bulk drain rather than
    // stranding it.
    const nowIso = new Date().toISOString()
    const { data: claimedRows, error: claimErr } = await supabaseAdmin
      .from('email_queue')
      .update({ status: 'Processing', claimed_at: nowIso })
      .eq('id', id)
      .eq('status', 'Error')
      .select()

    if (claimErr) {
      throw new Error('Failed to claim the queue row for retry: ' + claimErr.message)
    }

    if (!claimedRows || claimedRows.length === 0) {
      // Distinguish "doesn't exist" from "not in a retryable state" so the
      // admin gets a message that explains itself.
      const { data: existing } = await supabaseAdmin
        .from('email_queue')
        .select('status')
        .eq('id', id)
        .maybeSingle()

      if (!existing) {
        return new Response(JSON.stringify({ error: 'Email queue entry not found.' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({
        error: `Only failed sends can be retried — this entry is currently "${existing.status}".`
      }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const row = claimedRows[0]

    let status = 'Sent'
    let errorMessage: string | null = null
    try {
      await sendViaZoho(supabaseAdmin, {
        recipient: row.recipient,
        subject: row.subject,
        body: row.body,
      })
    } catch (e: any) {
      status = 'Error'
      errorMessage = e.message
    }

    const { error: updateErr } = await supabaseAdmin
      .from('email_queue')
      .update({
        status,
        error_message: errorMessage,
        retry_count: (row.retry_count ?? 0) + 1,
        last_retry_at: nowIso,
      })
      .eq('id', id)

    // A failed status write is worth surfacing rather than swallowing: the
    // email may well have been sent, but the row would still read
    // 'Processing', so the admin needs to know not to just hit Retry again.
    if (updateErr) {
      throw new Error(
        `Email ${status === 'Sent' ? 'was sent' : 'send failed'}, but recording the result failed: ` +
        updateErr.message
      )
    }

    return new Response(JSON.stringify({
      success: status === 'Sent',
      status,
      error_message: errorMessage,
      retry_count: (row.retry_count ?? 0) + 1,
    }), {
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
