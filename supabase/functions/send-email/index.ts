import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendViaZoho } from '../_shared/zoho.ts'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'
import { captureAndFlush } from '../_shared/sentry.ts'
import { resolveCallerAdminScope, isAuthorizedForOrg, type CallerAdminScope } from '../_shared/tenant-auth.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

Deno.serve(async (req) => {
  // Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Verify caller: either a trusted server-to-server call (another Edge
    // Function presenting the service role key, e.g. submit-booking sending
    // the "received" auto-responder) or an authenticated admin user.
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
    // own) - get_accounts below uses this to determine which single
    // organisation's Zoho settings it may write to.
    let callerScope: CallerAdminScope | null = null

    if (!isTrustedServiceCall) {
      const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token)
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized: ' + authError?.message }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // organisation_members-based - see queue-bulk-email's identical
      // comment. user_roles.role is NOT org-scoped (every organisation's
      // admin gets a row there), so checking it alone - the previous
      // behaviour - let any organisation's admin reach get_accounts below
      // and overwrite ANY other organisation's cached Zoho access token,
      // including org_default's (E5-25).
      callerScope = await resolveCallerAdminScope(supabaseClient, user.id)
      if (!callerScope.isPlatformAdmin && callerScope.orgIds.length === 0) {
        return new Response(JSON.stringify({ error: 'Forbidden: Admin role required' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }

    // Parse request body
    const reqBody = await req.json()
    const { action } = reqBody

    // -------------------------------------------------------------
    // ACTION: GET_ACCOUNTS (Retrieve numeric account IDs for user config)
    // -------------------------------------------------------------
    if (action === 'get_accounts') {
      // The organisation this call may cache a Zoho access token for is
      // derived entirely from the caller's own real membership, never from
      // the request body - this is the fix for E5-25: the token cache below
      // used to have no org_id at all, which meant it silently wrote to
      // whichever organisation the settings table's own DEFAULT happens to
      // be (org_default), regardless of which organisation's admin - or
      // whose Zoho credentials - actually triggered it.
      //
      // No service-role/internal caller of get_accounts exists anywhere in
      // this codebase (confirmed by grep - every other Zoho-sending
      // function calls sendViaZoho() directly in-process rather than
      // invoking send-email over HTTP), and there is no legitimate
      // *system*-generated reason to exchange freshly user-supplied OAuth
      // credentials, so a trusted service-role call is refused here rather
      // than guessing an organisation for it.
      if (!callerScope) {
        return new Response(JSON.stringify({ error: 'get_accounts requires an authenticated admin session.' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      // A genuine platform admin configuring org_default's own Zoho
      // integration is the one case already confirmed live in production
      // (HANDOVER.md) - resolved deterministically rather than via
      // orgIds.length, since a platform admin could in principle also hold
      // a second organisation's membership. An ordinary tenant admin must
      // belong to exactly one organisation for this to be unambiguous;
      // there is no established multi-org-admin flow to disambiguate
      // against, so that shape is refused rather than guessed at.
      const targetOrgId = callerScope.isPlatformAdmin
        ? 'org_default'
        : (callerScope.orgIds.length === 1 ? callerScope.orgIds[0] : null)

      if (!targetOrgId) {
        return new Response(JSON.stringify({
          error: 'Ambiguous organisation: this admin account belongs to more than one organisation, and get_accounts cannot determine which one to configure Zoho for.'
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const { clientId, clientSecret, refreshToken, accountsDomain, apiDomain } = reqBody
      if (!clientId || !clientSecret || !refreshToken) {
        return new Response(JSON.stringify({ error: 'Missing Client ID, Secret, or Refresh Token' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const tokenUrl = `${accountsDomain || 'https://accounts.zoho.eu'}/oauth/v2/token`
      const params = new URLSearchParams()
      params.append('grant_type', 'refresh_token')
      params.append('refresh_token', refreshToken)
      params.append('client_id', clientId)
      params.append('client_secret', clientSecret)

      const tokenResponse = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      })

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text()
        throw new Error(`Failed to refresh Zoho token: ${errorText}`)
      }

      const tokenData = await tokenResponse.json()
      const accessToken = tokenData.access_token
      if (!accessToken) {
        throw new Error('Zoho token response did not contain an access token.')
      }

      // Calculate expiration and cache back to Supabase settings
      const expiresInSec = tokenData.expires_in || 3600
      const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString()
      const nowStr = new Date().toISOString()

      const { error: saveError } = await supabaseClient
        .from('settings')
        .upsert([
          { org_id: targetOrgId, key: 'zoho_access_token', value: accessToken, updated_at: nowStr, updated_by: 'system_edge_function' },
          { org_id: targetOrgId, key: 'zoho_access_token_expires_at', value: expiresAt, updated_at: nowStr, updated_by: 'system_edge_function' }
        ], { onConflict: 'org_id,key' })
      if (saveError) {
        console.warn('Failed to cache Zoho access token in database during get_accounts:', saveError.message)
      }

      const accountsUrl = `${apiDomain || 'https://mail.zoho.eu'}/api/accounts`
      const accountsResponse = await fetch(accountsUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`
        }
      })

      if (!accountsResponse.ok) {
        const errorText = await accountsResponse.text()
        throw new Error(`Failed to fetch Zoho accounts: ${errorText}`)
      }

      const accountsData = await accountsResponse.json()
      return new Response(JSON.stringify({ success: true, data: accountsData }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // -------------------------------------------------------------
    // ACTION: DEFAULT (Send Email)
    // -------------------------------------------------------------
    const { recipient, subject, body, bcc, orgId } = reqBody

    // Which organisation's Zoho credentials this send actually uses is never
    // trusted blindly from the client. js/api.js's sendEmail(id, ...) is the
    // real resource-derived caller: it resolves orgId itself from the target
    // booking's own row (RLS-scoped to organisations the caller can already
    // see) before calling sendEmailDirect(), so for every legitimate call
    // this validation is a no-op — it only rejects a forged value that
    // doesn't match who the caller actually is. Mirrors send-sms's identical
    // resolution exactly (E5-26).
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

    const result = await sendViaZoho(supabaseClient, { recipient, subject, body, bcc }, resolvedOrgId)

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error: any) {
    await captureAndFlush(error, 'send-email')
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
