import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendViaZoho } from '../_shared/zoho.ts'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'

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

    if (!isTrustedServiceCall) {
      const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token)
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized: ' + authError?.message }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Verify user has admin role in database
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
    }

    // Parse request body
    const reqBody = await req.json()
    const { action } = reqBody

    // -------------------------------------------------------------
    // ACTION: GET_ACCOUNTS (Retrieve numeric account IDs for user config)
    // -------------------------------------------------------------
    if (action === 'get_accounts') {
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
          { key: 'zoho_access_token', value: accessToken, updated_at: nowStr, updated_by: 'system_edge_function' },
          { key: 'zoho_access_token_expires_at', value: expiresAt, updated_at: nowStr, updated_by: 'system_edge_function' }
        ])
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
    const { recipient, subject, body, bcc } = reqBody
    const result = await sendViaZoho(supabaseClient, { recipient, subject, body, bcc })

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
