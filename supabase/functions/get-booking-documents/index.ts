import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getBucketName } from '../_shared/bucket.ts'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'
import { captureAndFlush } from '../_shared/sentry.ts'
import { resolveCallerAdminScope } from '../_shared/tenant-auth.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
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

    // organisation_members-based - see queue-bulk-email's identical comment.
    // user_roles.role is NOT org-scoped (every org's admin gets a row there),
    // so checking it alone would let any organisation's admin read any
    // OTHER organisation's uploaded documents.
    const callerScope = await resolveCallerAdminScope(supabaseClient, user.id)
    if (!callerScope.isPlatformAdmin && callerScope.orgIds.length === 0) {
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

    // org_id is selected so it can be derived from the booking itself below
    // (never from client input) for the bucket lookup. The org filter is
    // applied to the query itself (same pattern as retry-queued-sms and
    // refund-payment) rather than checked after the fact, so a cross-tenant
    // booking id reads as a plain 404 - it never even reveals that the
    // booking exists.
    let bookingQuery = supabaseClient
      .from('bookings')
      .select('org_id, documents')
      .eq('id', bookingId)
    if (!callerScope.isPlatformAdmin) {
      bookingQuery = bookingQuery.in('org_id', callerScope.orgIds)
    }
    const { data: booking, error: bookingErr } = await bookingQuery.single()

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

    const bucketName = await getBucketName(supabaseClient, booking.org_id)
    const { data: signedData, error: signErr } = await supabaseClient.storage
      .from(bucketName)
      .createSignedUrls(paths, SIGNED_URL_EXPIRY_SECONDS)

    if (signErr) {
      throw new Error('Failed to create signed URLs: ' + signErr.message)
    }

    // Preserve input order; a per-file signing failure yields null rather
    // than failing the whole request. createSignedUrls() already returns a
    // full absolute URL (it builds it internally as `${this.url}${signedURL}`),
    // not a relative path — don't re-prefix it with supabaseUrl.
    const documents = (signedData || []).map((entry) => {
      if (entry.error || !entry.signedUrl) {
        console.warn('Failed to sign document path:', entry.path, entry.error)
        return null
      }
      return entry.signedUrl
    })

    return new Response(JSON.stringify({ documents }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error: any) {
    await captureAndFlush(error, 'get-booking-documents')
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
