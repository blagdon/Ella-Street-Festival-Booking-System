import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// No DEFAULT_BASE_URL constant here (E5-23): unlike provision-organisation
// (no settings exist yet mid-provisioning, so a hardcoded default is the
// only option) and stripe-webhook (a genuinely platform-level call with no
// org context), this function always has an explicit target organisation -
// falling back to a shared URL when that org has no base_url of its own
// would undermine the exact invariant this fix establishes. Enforced inside
// rpc_add_organisation_member itself, not here - see that migration's
// header comment for why.

/**
 * Adds a member to an explicitly-named target organisation and, if they
 * don't already have a real login, sends them a genuine Supabase invite
 * email pointing at that organisation's own base_url.
 *
 * rpc_add_organisation_member alone (still the thing that actually inserts
 * the user_roles/organisation_members rows - called here, unchanged, AS the
 * caller) only ever created a placeholder row with a random UUID. No email
 * was ever sent, so an invitee had no way to discover they needed to sign
 * up, and no self-service signup page existed even if they did know - see
 * the RC operational certification's Finding 1. Postgres itself can't send
 * email, hence this Edge Function wrapper around the existing RPC.
 *
 * The RPC is invoked with the caller's own JWT (not the service role) so
 * its existing is_authorised_for_org(p_org_id, ...) check - the real
 * authorization boundary for "which org does this add to" - is reused
 * exactly as the client-side "Add Member" dialog already relies on, rather
 * than re-derived here and risking a second, subtly different answer.
 *
 * E5-23: the target organisation is now an explicit orgId in the request
 * body, not resolved ambiently. get_current_org_id() (a platform admin's
 * own session context, not necessarily the org they've selected in the
 * UI's org-switcher) is deliberately never consulted here - the RPC's own
 * returned org_id (the organisation it actually authorised against and
 * wrote the membership into) is what drives the base_url lookup below, not
 * a second, independent derivation of "current org".
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''

    if (!supabaseUrl || !supabaseServiceKey || !supabaseAnonKey) {
      return new Response(
        JSON.stringify({ error: 'Server misconfiguration: Supabase credentials are missing' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const body = await req.json()
    const email = String(body?.email || '').trim()
    const role = String(body?.role || '').trim()
    const orgId = String(body?.orgId || '').trim()

    if (!email || !role) {
      return new Response(
        JSON.stringify({ error: 'email and role are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!orgId) {
      return new Response(
        JSON.stringify({ error: 'orgId is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    })

    const { data: rpcResult, error: rpcErr } = await callerClient.rpc('rpc_add_organisation_member', {
      p_org_id: orgId,
      p_email: email,
      p_role: role
    })

    if (rpcErr) {
      return new Response(
        JSON.stringify({ error: rpcErr.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // The organisation the RPC actually authorised against and wrote the
    // membership into - not orgId re-read from the request, and not
    // get_current_org_id() - is what the invite link's base_url must match.
    const targetOrgId = rpcResult?.org_id
    const userId = rpcResult?.user_id
    // Whether this invitee is genuinely new (no real login yet) is now
    // decided once, inside the RPC's own transaction (E5-23 revision) - the
    // RPC already refuses the whole call for a new invitee whose target org
    // has no base_url, so by the time control reaches here, a new invitee
    // is guaranteed to have a usable base_url. No second getUserById lookup
    // needed to re-derive what the RPC already determined authoritatively.
    const isNewInvitee = rpcResult?.is_new_invitee === true
    let inviteSent = false

    if (userId && isNewInvitee) {
      const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

      // The target org's own base_url - never the caller's organisation,
      // never a shared platform default, never org_default unless
      // targetOrgId literally is org_default (E5-23). Guaranteed present at
      // this point for a new invitee (the RPC already enforced that); this
      // lookup exists only to get the actual value for the redirect URL.
      const { data: settingsRow } = await supabaseAdmin
        .from('settings')
        .select('value')
        .eq('org_id', targetOrgId)
        .eq('key', 'base_url')
        .single()
      const baseUrl = settingsRow?.value

      const { error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
        redirectTo: `${baseUrl}/index.html`
      })
      if (inviteErr) {
        // Not fatal - the member row is already created, and the existing
        // link_pending_user_roles_on_signup trigger still re-links this
        // placeholder id if they ever do sign up independently later.
        console.warn('[invite-organisation-member] inviteUserByEmail failed:', inviteErr.message)
      } else {
        inviteSent = true
      }
    }

    return new Response(
      JSON.stringify({ ...rpcResult, invite_sent: inviteSent }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || 'Failed to add member' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
