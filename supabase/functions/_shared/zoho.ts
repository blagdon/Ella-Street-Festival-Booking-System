import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * Extracted from send-email/index.ts's default "send email" action so it
 * can be called in-process (no HTTP hop) from queue-bulk-email's background
 * drain loop, instead of that loop invoking send-email as a separate Edge
 * Function 50+ times in a row — which was intermittently failing with
 * "Failed to send a request to the Edge Function" (a raw fetch-level
 * failure, no response at all) even after retries, apparently from
 * hammering the same sibling function with many rapid sequential
 * invocations. Behavior here is unchanged from the original — same
 * settings, same token caching/refresh, same Zoho payload shape.
 */
export async function sendViaZoho(
  supabaseAdmin: ReturnType<typeof createClient>,
  params: { recipient: string; subject: string; body: string; bcc?: string | null }
): Promise<{ success: true; data: any }> {
  const { recipient, subject, body, bcc } = params
  if (!recipient || !subject || !body) {
    throw new Error('Missing required fields: recipient, subject, body')
  }

  const { data: settingsData, error: settingsError } = await supabaseAdmin
    .from('settings')
    .select('key, value')
    .in('key', [
      'zoho_client_id',
      'zoho_client_secret',
      'zoho_refresh_token',
      'zoho_account_id',
      'zoho_from_address',
      'zoho_display_name',
      'zoho_access_token',
      'zoho_access_token_expires_at',
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
  const fromAddress = settings['zoho_from_address'] || 'festival.stalls@ellastreet.co.uk'
  const displayName = settings['zoho_display_name'] || 'Ella Street Festival Stalls'
  const apiDomain = settings['zoho_api_domain'] || 'https://mail.zoho.eu'
  const accountsDomain = settings['zoho_accounts_domain'] || 'https://accounts.zoho.eu'

  if (!clientId || !clientSecret || !refreshToken || !accountId) {
    throw new Error('Missing required Zoho API configuration settings in database.')
  }

  let accessToken = settings['zoho_access_token']
  const expiresAtStr = settings['zoho_access_token_expires_at']
  let tokenNeedsRefresh = true

  if (accessToken && expiresAtStr) {
    const expiresAt = new Date(expiresAtStr).getTime()
    // If it expires more than 5 minutes in the future, we can reuse it
    if (expiresAt > Date.now() + 300000) {
      tokenNeedsRefresh = false
    }
  }

  if (tokenNeedsRefresh) {
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
    accessToken = tokenData.access_token
    if (!accessToken) {
      throw new Error('Zoho token response did not contain an access token.')
    }

    const expiresInSec = tokenData.expires_in || 3600
    const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString()
    const nowStr = new Date().toISOString()

    const { error: saveError } = await supabaseAdmin
      .from('settings')
      .upsert([
        { key: 'zoho_access_token', value: accessToken, updated_at: nowStr, updated_by: 'system_edge_function' },
        { key: 'zoho_access_token_expires_at', value: expiresAt, updated_at: nowStr, updated_by: 'system_edge_function' }
      ])
    if (saveError) {
      console.warn('Failed to cache Zoho access token in database:', saveError.message)
    }
  }

  const sendUrl = `${apiDomain}/api/accounts/${accountId}/messages`
  const emailPayload: Record<string, any> = {
    fromAddress: `"${displayName}" <${fromAddress}>`,
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
  return { success: true, data: responseJson }
}
