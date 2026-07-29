import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkDeliveryStatus } from '../_shared/sms.ts'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'
import { captureAndFlush } from '../_shared/sentry.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/**
 * Checks a single sms_queue row's ACTUAL delivery outcome with The SMS
 * Works, for the SMS Queue viewer's "Check Delivery" button. Same auth
 * shape as retry-queued-sms: admin JWT only, no service-role bypass — this
 * is a human action from the viewer, nothing server-side should trigger it.
 *
 * Deliberately on-demand only. There is no confirmed rate limit or
 * delivery-latency SLA from The SMS Works, so this never runs automatically
 * (not on page load, not right after a send) — only when an admin clicks.
 *
 * `status`/`error_message` on the row are NOT touched here — delivery
 * outcome is stored separately in delivery_status/delivery_checked_at/
 * delivery_failure_reason and never changes retry eligibility. See the
 * migration's docstring for why: re-submitting a message that was accepted
 * but later reported undeliverable would just pay for and likely repeat the
 * same carrier-side failure.
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
      return new Response(JSON.stringify({ error: 'A numeric sms_queue id is required.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { data: row, error: fetchErr } = await supabaseAdmin
      .from('sms_queue')
      .select('id, provider_message_id')
      .eq('id', id)
      .maybeSingle()

    if (fetchErr) throw new Error('Failed to look up the queue row: ' + fetchErr.message)
    if (!row) {
      return new Response(JSON.stringify({ error: 'SMS queue entry not found.' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Nothing to check for a simulated send (Test Mode / mock provider) or a
    // row that was never accepted by a real provider in the first place —
    // this is a clean, expected outcome, not an error.
    if (!row.provider_message_id || row.provider_message_id.startsWith('mock-')) {
      return new Response(JSON.stringify({
        skipped: true,
        reason: row.provider_message_id
          ? 'This message was simulated (SMS Test Mode was on when it was sent) — there is nothing to check.'
          : 'This message has no provider message id to check.',
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const nowIso = new Date().toISOString()
    const result = await checkDeliveryStatus(supabaseAdmin, row.provider_message_id)

    const { error: updateErr } = await supabaseAdmin
      .from('sms_queue')
      .update({
        delivery_status: result.status,
        delivery_checked_at: nowIso,
        delivery_failure_reason: result.failureReason,
      })
      .eq('id', id)

    if (updateErr) throw new Error('Delivery status checked but failed to save: ' + updateErr.message)

    return new Response(JSON.stringify({
      skipped: false,
      delivery_status: result.status,
      delivery_checked_at: nowIso,
      delivery_failure_reason: result.failureReason,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error: any) {
    await captureAndFlush(error, 'check-sms-delivery')
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
