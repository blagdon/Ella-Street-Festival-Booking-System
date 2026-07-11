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
    const { token, bookingData, tempUuid, fileNames } = await req.json()

    if (!token || !bookingData) {
      return new Response(JSON.stringify({ error: 'Missing CAPTCHA token or booking data.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 1. Verify Cloudflare Turnstile CAPTCHA
    const turnstileSecret = Deno.env.get('TURNSTILE_SECRET_KEY')
    if (!turnstileSecret) {
      throw new Error('TURNSTILE_SECRET_KEY is not configured on the server.')
    }

    const cfVerify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: turnstileSecret,
        response: token
      }),
    })
    
    const cfResponse = await cfVerify.json()
    if (!cfResponse.success) {
      const cfErrors = cfResponse['error-codes'] ? cfResponse['error-codes'].join(', ') : 'Unknown Cloudflare Error';
      return new Response(JSON.stringify({ 
        error: `CAPTCHA Rejected by Cloudflare. Reason: [${cfErrors}]` 
      }), { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      })
    }

    // 2. Initialize Supabase client with service role to bypass RLS for insertion
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 3. Atomically generate the next sequential ID
    const { data: newBookingId, error: rpcErr } = await supabaseAdmin.rpc('get_next_booking_id', {
      p_prefix: bookingData.instance_prefix
    })

    if (rpcErr || !newBookingId) {
      throw new Error('Failed to generate Booking ID: ' + (rpcErr?.message || 'Empty ID returned.'))
    }

    bookingData.id = newBookingId
    bookingData.status = 'Pending'

    // 4. Move files from temporary location to final folder in Storage
    if (tempUuid && fileNames && Array.isArray(fileNames) && fileNames.length > 0) {
      const bucketName = Deno.env.get('BUCKET_NAME') || 'esf-documents'
      const movedUrls = []

      for (const fileName of fileNames) {
        const fromPath = `temp/${tempUuid}/${fileName}`
        const toPath = `${newBookingId}/${fileName}`

        // Move the file
        const { error: moveErr } = await supabaseAdmin.storage.from(bucketName).move(fromPath, toPath)
        if (moveErr) {
          console.warn(`Failed to move file ${fromPath} to ${toPath}:`, moveErr.message)
          // Fallback: If move fails, try using the original temp URL if available
        }

        // Get final public URL
        const { data: urlData } = supabaseAdmin.storage.from(bucketName).getPublicUrl(toPath)
        movedUrls.push(urlData.publicUrl)
      }

      bookingData.documents = movedUrls
    }

    // 5. Insert booking into database
    const { data, error } = await supabaseAdmin.from('bookings').insert([bookingData]).select()
    if (error) throw error

    return new Response(JSON.stringify({ success: true, data }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
