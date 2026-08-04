import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const DEFAULT_BASE_URL = 'https://app.ellastreet.co.uk'

/**
 * Adds a member to the caller's current organisation and, if they don't
 * already have a real login, sends them a genuine Supabase invite email.
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
 * its existing check_user_role('admin') / get_current_org_id() checks - the
 * real authorization boundary for "which org does this add to" - are reused
 * exactly as the client-side "Add Member" dialog already relies on, rather
 * than re-derived here and risking a second, subtly different answer.
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

    if (!email || !role) {
      return new Response(
        JSON.stringify({ error: 'email and role are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    })

    const { data: rpcResult, error: rpcErr } = await callerClient.rpc('rpc_add_organisation_member', {
      p_email: email,
      p_role: role
    })

    if (rpcErr) {
      return new Response(
        JSON.stringify({ error: rpcErr.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const userId = rpcResult?.user_id
    let inviteSent = false

    if (userId) {
      const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

      // A placeholder id from the RPC (brand new invitee, or one still
      // waiting on their first sign-up) doesn't exist in auth.users yet -
      // getUserById errors for it rather than returning null data, so the
      // absence of a user is what "needs an invite" actually looks like.
      const { data: existing } = await supabaseAdmin.auth.admin.getUserById(userId).catch(() => ({ data: null }))

      if (!existing?.user) {
        const { error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
          redirectTo: `${DEFAULT_BASE_URL}/index.html`
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
