import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendViaSms } from '../_shared/sms.ts'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'
import { captureAndFlush } from '../_shared/sentry.ts'
import { resolveCallerAdminScope } from '../_shared/tenant-auth.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/**
 * Re-sends a single failed sms_queue row, for the SMS Queue viewer's "Retry"
 * button. The SMS twin of retry-queued-email.
 *
 * Why an Edge Function: `authenticated` has SELECT+INSERT on sms_queue but no
 * UPDATE (status transitions are service-role/RPC only, mirroring email_queue),
 * and the provider credentials are server-side. So the admin client can read
 * the failed row but can neither send nor mark the result; both happen here.
 * Calls sendViaSms() in-process, same pattern as the rest of the SMS/email path.
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

    // Admin JWT only — deliberately no service-role bypass. Retrying is a human
    // recovery action from the viewer; nothing server-side should trigger it.
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

    // organisation_members-based - see queue-bulk-email's identical comment.
    const callerScope = await resolveCallerAdminScope(supabaseAdmin, user.id)
    if (!callerScope.isPlatformAdmin && callerScope.orgIds.length === 0) {
      return new Response(JSON.stringify({ error: 'Forbidden: Admin role required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { id } = await req.json()
    if (!Number.isInteger(id)) {
      return new Response(JSON.stringify({ error: 'A numeric sms_queue id is required.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Claim by flipping Error -> Processing conditionally; "no rows updated"
    // is the rejection. Same concurrency guarantees as retry-queued-email:
    //  - overlapping in-flight retries: only one sends (other gets 409)
    //  - retry after success: refused (row is 'Sent', not claimable) — a
    //    delivered text is never delivered (or billed) twice
    //  - retry after failure: allowed (row is back to 'Error') — the point
    // A crash between claim and finish leaves the row 'Processing' with
    // claimed_at set; claim_pending_sms()'s 15-minute self-heal reclaims it.
    const nowIso = new Date().toISOString()
    let claimQuery = supabaseAdmin
      .from('sms_queue')
      .update({ status: 'Processing', claimed_at: nowIso })
      .eq('id', id)
      .eq('status', 'Error')

    if (!callerScope.isPlatformAdmin) {
      claimQuery = claimQuery.in('org_id', callerScope.orgIds)
    }

    const { data: claimedRows, error: claimErr } = await claimQuery.select()

    if (claimErr) {
      throw new Error('Failed to claim the queue row for retry: ' + claimErr.message)
    }

    if (!claimedRows || claimedRows.length === 0) {
      let existingQuery = supabaseAdmin.from('sms_queue').select('status').eq('id', id)
      if (!callerScope.isPlatformAdmin) {
        existingQuery = existingQuery.in('org_id', callerScope.orgIds)
      }
      const { data: existing } = await existingQuery.maybeSingle()

      if (!existing) {
        return new Response(JSON.stringify({ error: 'SMS queue entry not found.' }), {
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
    let providerMessageId: string | null = null
    let segments: number | null = null
    try {
      const result = await sendViaSms(supabaseAdmin, { recipient: row.recipient, body: row.body }, row.org_id)
      providerMessageId = result.providerMessageId
      segments = result.segments
    } catch (e: any) {
      status = 'Error'
      errorMessage = e.message
    }

    const { error: updateErr } = await supabaseAdmin
      .from('sms_queue')
      .update({
        status,
        error_message: errorMessage,
        provider_message_id: providerMessageId,
        segments,
        retry_count: (row.retry_count ?? 0) + 1,
        last_retry_at: nowIso,
      })
      .eq('id', id)

    // A failed status write is worth surfacing: the text may have been sent,
    // but the row would still read 'Processing', so the admin must know not to
    // just hit Retry again.
    if (updateErr) {
      throw new Error(
        `SMS ${status === 'Sent' ? 'was sent' : 'send failed'}, but recording the result failed: ` +
        updateErr.message
      )
    }

    return new Response(JSON.stringify({
      success: status === 'Sent',
      status,
      error_message: errorMessage,
      provider_message_id: providerMessageId,
      retry_count: (row.retry_count ?? 0) + 1,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error: any) {
    await captureAndFlush(error, 'retry-queued-sms')
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
