import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { token, cancelToken, reason } = await req.json()

    if (!token) {
      return new Response(JSON.stringify({ error: 'Please complete the CAPTCHA verification.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!cancelToken) {
      return new Response(JSON.stringify({ error: 'Missing cancellation token.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 1. Verify Turnstile CAPTCHA with Cloudflare siteverify API
    const turnstileSecret = Deno.env.get('TURNSTILE_SECRET_KEY')
    if (!turnstileSecret) {
      throw new Error('TURNSTILE_SECRET_KEY is not configured on the server.')
    }

    const verifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
    const formData = new URLSearchParams()
    formData.append('secret', turnstileSecret)
    formData.append('response', token)

    const verifyResponse = await fetch(verifyUrl, {
      method: 'POST',
      body: formData
    })

    const verifyData = await verifyResponse.json()
    if (!verifyData.success) {
      return new Response(JSON.stringify({ error: 'CAPTCHA verification failed. Please try again.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 2. Initialize Supabase client with Service Role Key
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Call the database function to cancel the booking
    const { data, error } = await supabaseClient.rpc('cancel_booking_secure', {
      p_token: cancelToken,
      p_reason: reason || null
    })

    if (error || (data && data.success === false)) {
      const errMsg = (data && data.error) ? data.error : 'Could not cancel. The link may have already been used or has expired.'
      return new Response(JSON.stringify({ error: errMsg }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
