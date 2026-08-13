import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendViaSms, normalizePhone } from '../_shared/sms.ts'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'
import { captureAndFlush } from '../_shared/sentry.ts'
import { resolveCallerAdminScope, isAuthorizedForOrg, type CallerAdminScope } from '../_shared/tenant-auth.ts'

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

    // Populated only for a real authenticated admin (stays null for a
    // trusted service-role call, which has no caller organisation of its
    // own to check the request body's orgId against).
    let callerScope: CallerAdminScope | null = null

    if (!isTrustedServiceCall) {
      const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized: ' + authError?.message }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // organisation_members-based - see queue-bulk-email's identical
      // comment. user_roles.role is NOT org-scoped (every organisation's
      // admin gets a row there), so checking it alone - the previous
      // behaviour - let any organisation's admin send SMS on org_default's
      // budget and freely forge which organisation's sms_queue log an SMS
      // was attributed to, since the orgId field below was never checked
      // against who the caller actually is (E5-26).
      callerScope = await resolveCallerAdminScope(supabaseAdmin, user.id)
      if (!callerScope.isPlatformAdmin && callerScope.orgIds.length === 0) {
        return new Response(JSON.stringify({ error: 'Forbidden: Admin role required' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }

    const { recipient, body, orgId } = await req.json()

    // Which organisation this send is billed/attributed to - and whose SMS
    // provider settings sendViaSms() below actually uses - is never trusted
    // blindly from the client. js/api.js's sendBookingSms is the only real
    // caller: it resolves orgId itself from the target booking's own row
    // (RLS-scoped to organisations the caller can already see), so for
    // every legitimate call this validation is a no-op - it only rejects a
    // forged value that doesn't match who the caller actually is. A trusted
    // service-role call has no session to check orgId against, so it's
    // taken as-is (or defaulted), matching how every other service-role
    // path in this codebase already trusts the service-role boundary
    // itself rather than re-deriving one.
    let resolvedOrgId: string
    if (isTrustedServiceCall) {
      resolvedOrgId = (typeof orgId === 'string' && orgId) ? orgId : 'org_default'
    } else if (typeof orgId === 'string' && orgId) {
      if (!isAuthorizedForOrg(callerScope!, orgId)) {
        return new Response(JSON.stringify({ error: 'Forbidden: not authorised for the requested organisation.' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      resolvedOrgId = orgId
    } else if (callerScope!.isPlatformAdmin) {
      resolvedOrgId = 'org_default'
    } else if (callerScope!.orgIds.length === 1) {
      resolvedOrgId = callerScope!.orgIds[0]
    } else {
      return new Response(JSON.stringify({ error: 'Ambiguous organisation: this admin account belongs to more than one organisation, and no orgId was supplied to disambiguate.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

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
      const result = await sendViaSms(supabaseAdmin, { recipient: to, body }, resolvedOrgId)
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
      org_id: resolvedOrgId,
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
    await captureAndFlush(error, 'send-sms')
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
