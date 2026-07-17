import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // This endpoint calls SerpApi on every request, which is metered/paid —
    // require an authenticated admin (same check as send-email) so a public
    // caller with just the anon key (which alone satisfies Supabase's
    // platform-level JWT gate) can't script requests against it and run up
    // the bill or exhaust rate limits.
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

    const { business_name } = await req.json()

    if (!business_name) {
      return new Response(JSON.stringify({ error: 'Missing business name.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 2. Fetch SerpApi key and map center from env/settings table (single query)
    const { data: settingsRows } = await supabaseClient
      .from('settings')
      .select('key, value')
      .in('key', ['serpapi_api_key', 'map_center_lat', 'map_center_lng'])
    const settingsMap = new Map((settingsRows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]))

    let apiKey = Deno.env.get('SERPAPI_API_KEY')
    if (!apiKey) {
      apiKey = settingsMap.get('serpapi_api_key')
    }

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'SerpApi API Key not configured. Please configure it in System Settings.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Festival site GPS center, sourced from settings (map_center_lat/lng) so
    // it stays in sync with the same values the visitor map uses — falls back
    // to a Hull, UK city-level default if the settings rows are missing.
    const siteLat = parseFloat(settingsMap.get('map_center_lat') ?? '') || 53.7676
    const siteLon = parseFloat(settingsMap.get('map_center_lng') ?? '') || -0.3274

    // Append 'Hull' to scope search locally
    const searchQuery = `${business_name} Hull`

    // 3. Search Google Maps for the business via SerpApi, biased to Hull, UK
    //    via the `ll` (latitude,longitude,zoom) parameter — without this, a
    //    bare "Hull" keyword can match Hull, Georgia (USA) just as easily as
    //    Hull, UK, since Maps search has no country/region context otherwise.
    const HULL_UK_LL = `@${siteLat},${siteLon},13z`
    // NOTE: ll is sent unencoded — every SerpApi doc example does this
    // (e.g. ll=@40.7455096,-74.0083012,14z directly in the URL). Wrapping it
    // in encodeURIComponent turns "@"/"," into %40/%2C, which may not parse
    // the same way server-side.
    const searchUrl = `https://serpapi.com/search.json?engine=google_maps&type=search&q=${encodeURIComponent(searchQuery)}&ll=${HULL_UK_LL}&google_domain=google.co.uk&gl=uk&api_key=${apiKey}`
    const searchResponse = await fetch(searchUrl)
    if (!searchResponse.ok) {
      throw new Error(`SerpApi Google Maps search failed with status ${searchResponse.status}`)
    }

    const searchData = await searchResponse.json()

    // SerpApi returns a `local_results` array when a query has multiple
    // candidate matches, but a single `place_results` object (not an array)
    // when it resolves to one confident, unambiguous match — which happens
    // more often now that the search is properly location-biased. Fall back
    // to place_results if local_results is empty.
    const firstResult = searchData.local_results?.[0] || searchData.place_results

    if (!firstResult) {
      return new Response(JSON.stringify({ found: false, message: 'No Google Maps results found.' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Guard against a confident-looking but wrong match. Require at least one
    // shared whole word (3+ letters) between the queried name and the result title.
    const normalizeForMatch = (s: string) =>
      (s || '').toLowerCase().replace(/[-'']/g, ' ').replace(/\s+/g, ' ').trim()

    const isRelevantMatch = (resultTitle: string, name: string) => {
      const normTitle = normalizeForMatch(resultTitle)
      const normName  = normalizeForMatch(name)
      // Primary: shared whole word (3+ chars)
      const titleWords = new Set(normTitle.split(' ').filter(w => w.length > 2))
      const nameWords  = normName.split(' ').filter(w => w.length > 2)
      if (nameWords.some(w => titleWords.has(w))) return true
      // Fallback 1: substring containment (handles short/possessive names like "Barley's")
      if (normTitle.includes(normName) || normName.includes(normTitle)) return true
      // Fallback 2: domain-style names with no spaces at all (e.g. a trading
      // name stored as "lovehogroast.com" against a listing titled
      // "Hog Roast Hull") — strip a trailing domain suffix, remove all
      // spaces, and check whether any real title word (4+ chars, to avoid
      // noise from short generic words) appears inside the run-together name.
      const nameNoSuffix  = normName.replace(/\.(com|co\.uk|org|net|shop|uk)$/i, '')
      const nameNoSpaces  = nameNoSuffix.replace(/\s+/g, '')
      if (nameNoSpaces.length > 3) {
        const substantialTitleWords = normTitle.split(' ').filter(w => w.length >= 4)
        if (substantialTitleWords.some(w => nameNoSpaces.includes(w))) return true
      }
      return false
    }

    const relevant = isRelevantMatch(firstResult.title, business_name)

    if (!relevant) {
      return new Response(JSON.stringify({
        found: false,
        message: `No confident Google Maps match found for "${business_name}".`
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Backstop against the location bias not being fully respected: reject
    // any result whose coordinates are far from Hull, UK. Using distance
    // from GPS coordinates rather than parsing the address string, since
    // mobile caterers/trailers (e.g. a horsebox bar) often have no `address`
    // field at all — only `gps_coordinates` — which an address-text check
    // would wrongly treat as "not UK" and reject.
    const MAX_DISTANCE_KM = 80 // generous radius to cover East Yorkshire mobile caterers

    const distanceKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
      const R = 6371
      const dLat = (lat2 - lat1) * Math.PI / 180
      const dLon = (lon2 - lon1) * Math.PI / 180
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    }

    const coords = firstResult.gps_coordinates
    const isNearHull = coords
      ? distanceKm(siteLat, siteLon, coords.latitude, coords.longitude) <= MAX_DISTANCE_KM
      : false

    if (!isNearHull) {
      return new Response(JSON.stringify({
        found: false,
        message: `No confident Google Maps match found for "${business_name}" in Hull, UK.`
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const data_id  = firstResult.data_id   // used for reviews lookup
    const place_id = firstResult.place_id  // Google place_id (informational)
    const title    = firstResult.title
    const thumbnail = firstResult.thumbnail ?? null
    const location  = firstResult.address ?? null
    const rating    = firstResult.rating ?? null
    const reviewsCount = firstResult.reviews ?? null

    // 4. Fetch the actual reviews using SerpApi Google Maps Reviews engine
    let reviewsList: Array<{ title: string; rating: number | null; comment: string; date: string }> = []
    if (data_id) {
      const reviewsUrl = `https://serpapi.com/search.json?engine=google_maps_reviews&data_id=${encodeURIComponent(data_id)}&api_key=${apiKey}`
      const reviewsResponse = await fetch(reviewsUrl)
      if (reviewsResponse.ok) {
        const reviewsData = await reviewsResponse.json()
        const rawReviews = reviewsData.reviews ?? []
        reviewsList = rawReviews.map((rev: any) => ({
          // Google Maps reviews have no separate title — use author name as substitute
          title:   rev.user?.name ?? 'Anonymous',
          rating:  rev.rating ?? null,
          comment: rev.snippet ?? '',
          date:    rev.date ?? ''
        }))
      }
    }

    return new Response(JSON.stringify({
      found: true,
      title,
      place_id,
      rating,
      reviewsCount,
      thumbnail,
      location,
      reviews: reviewsList.slice(0, 3) // Return top 3 reviews
    }), {
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