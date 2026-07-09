import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
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

    // Verify user authentication
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

    // Parse request body
    const { recipient, subject, body, bcc } = await req.json()
    if (!recipient || !subject || !body) {
      return new Response(JSON.stringify({ error: 'Missing required fields: recipient, subject, body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Fetch Zoho credentials from database settings table
    const { data: settingsData, error: settingsError } = await supabaseClient
      .from('settings')
      .select('key, value')
      .in('key', [
        'zoho_client_id',
        'zoho_client_secret',
        'zoho_refresh_token',
        'zoho_account_id',
        'zoho_from_address',
        'zoho_api_domain',
        'zoho_accounts_domain'
      ])

    if (settingsError) {
      throw new Error('Failed to load Zoho settings from database: ' + settingsError.message)
    }

    const settings: Record<string, string> = {}
    settingsData?.forEach((item) => {
      settings[item.key] = item.value
    })

    const clientId = settings['zoho_client_id']
    const clientSecret = settings['zoho_client_secret']
    const refreshToken = settings['zoho_refresh_token']
    const accountId = settings['zoho_account_id']
    const fromAddress = settings['zoho_from_address'] || 'festival_stalls@elleatreet.co.uk'
    const apiDomain = settings['zoho_api_domain'] || 'https://mail.zoho.eu'
    const accountsDomain = settings['zoho_accounts_domain'] || 'https://accounts.zoho.eu'

    if (!clientId || !clientSecret || !refreshToken || !accountId) {
      throw new Error('Missing required Zoho API configuration settings in database.')
    }

    // Refresh Zoho Token
    const tokenUrl = `${accountsDomain}/oauth/v2/token`
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
      throw new Error(`Failed to refresh Zoho access token: ${tokenResponse.statusText}. Details: ${errorText}`)
    }

    const tokenData = await tokenResponse.json()
    const accessToken = tokenData.access_token
    if (!accessToken) {
      throw new Error('Zoho token response did not contain an access token.')
    }

    // Send the Email
    const sendUrl = `${apiDomain}/api/accounts/${accountId}/messages`
    const emailPayload: Record<string, any> = {
      fromAddress: fromAddress,
      toAddress: recipient,
      subject: subject,
      content: body,
      mailFormat: 'html'
    }
    if (bcc) {
      emailPayload.bccAddress = bcc
    }

    const sendResponse = await fetch(sendUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(emailPayload)
    })

    if (!sendResponse.ok) {
      const errorText = await sendResponse.text()
      throw new Error(`Failed to send email via Zoho: ${sendResponse.statusText}. Details: ${errorText}`)
    }

    const responseJson = await sendResponse.json()

    return new Response(JSON.stringify({ success: true, data: responseJson }), {
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
