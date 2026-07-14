import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getBucketName } from '../_shared/bucket.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// How long a signed document link stays valid for — long enough for an
// admin to review a booking without the link expiring mid-session.
const SIGNED_URL_EXPIRY_SECONDS = 3600

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseClient = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Admin-only — bookings.documents entries are storage paths into a
    // private bucket, signed here so only authenticated admins can resolve
    // them to an actual downloadable URL.
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

    const { bookingId } = await req.json()
    if (!bookingId || typeof bookingId !== 'string') {
      return new Response(JSON.stringify({ error: 'bookingId is required.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { data: booking, error: bookingErr } = await supabaseClient
      .from('bookings')
      .select('documents')
      .eq('id', bookingId)
      .single()

    if (bookingErr || !booking) {
      return new Response(JSON.stringify({ error: 'Booking not found.' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const paths: string[] = Array.isArray(booking.documents) ? booking.documents : []
    if (paths.length === 0) {
      return new Response(JSON.stringify({ documents: [] }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const bucketName = await getBucketName(supabaseClient)
    const { data: signedData, error: signErr } = await supabaseClient.storage
      .from(bucketName)
      .createSignedUrls(paths, SIGNED_URL_EXPIRY_SECONDS)

    if (signErr) {
      throw new Error('Failed to create signed URLs: ' + signErr.message)
    }

    // Preserve input order; a per-file signing failure yields null rather
    // than failing the whole request.
    const documents = (signedData || []).map((entry) => {
      if (entry.error || !entry.signedUrl) {
        console.warn('Failed to sign document path:', entry.path, entry.error)
        return null
      }
      return `${supabaseUrl}${entry.signedUrl}`
    })

    return new Response(JSON.stringify({ documents }), {
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
