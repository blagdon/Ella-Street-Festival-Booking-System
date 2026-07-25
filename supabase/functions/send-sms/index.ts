import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendViaSms, normalizePhone } from '../_shared/sms.ts'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// One text can be up to ~10 concatenated parts; refuse anything absurd so a
// runaway body can't quietly cost a fortune.
const MAX_BODY_LEN = 1600

/**
 * Send a single SMS immediately. The SMS counterpart to send-email's default
 * action. Caller is either a trusted server-to-server call (another Edge
 * Function presenting the service role key — e.g. a future "booking confirmed"
 * auto-text) or an authenticated admin user. Mirrors send-email's auth exactly.
 *
 * This bypasses the queue and sends inline; use queue-bulk-sms for many
 * recipients. On success it still logs the outcome to sms_queue as 'Sent' so
 * every outbound text is auditable in one place.
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
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const isTrustedServiceCall = !!serviceRoleKey && token === serviceRoleKey

    if (!isTrustedServiceCall) {
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
    }

    const { recipient, body } = await req.json()

    if (!recipient || typeof recipient !== 'string') {
      return new Response(JSON.stringify({ error: 'A recipient phone number is required.' }), {
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

    // Normalise to E.164 up front so an invalid number is a clean 400, and so
    // the audit row records the exact string we sent to.
    let to: string
    try {
      to = normalizePhone(recipient)
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    let status = 'Sent'
    let errorMessage: string | null = null
    let providerMessageId: string | null = null
    let segments: number | null = null
    try {
      const result = await sendViaSms(supabaseAdmin, { recipient: to, body })
      providerMessageId = result.providerMessageId
      segments = result.segments
    } catch (e: any) {
      status = 'Error'
      errorMessage = e.message
    }

    // Log the outcome to sms_queue regardless, so inline and bulk sends share
    // one audit trail. A failed log write shouldn't mask the send result.
    const { error: logErr } = await supabaseAdmin.from('sms_queue').insert({
      recipient: to,
      body,
      status,
      error_message: errorMessage,
      segments,
      provider_message_id: providerMessageId,
    })
    if (logErr) console.warn('Failed to log sms_queue row:', logErr.message)

    return new Response(JSON.stringify({
      success: status === 'Sent',
      status,
      // The normalised E.164 number actually sent to, so the caller can audit
      // what was really used rather than the raw stored string it passed in.
      recipient: to,
      error_message: errorMessage,
      provider_message_id: providerMessageId,
      segments,
    }), {
      status: status === 'Sent' ? 200 : 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
