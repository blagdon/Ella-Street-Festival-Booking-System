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
    const { business_name } = await req.json()

    if (!business_name) {
      return new Response(JSON.stringify({ error: 'Missing business name.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 1. Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 2. Fetch SerpApi key from env or settings table
    let apiKey = Deno.env.get('SERPAPI_API_KEY')
    if (!apiKey) {
      const { data: settingData } = await supabaseClient
        .from('settings')
        .select('value')
        .eq('key', 'serpapi_api_key')
        .single()
      apiKey = settingData?.value
    }

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'SerpApi API Key not configured. Please configure it in System Settings.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Append 'Hull' to scope search locally
    const searchQuery = `${business_name} Hull`

    // 3. Search Google Maps for the business via SerpApi, biased to Hull, UK
    //    via the `ll` (latitude,longitude,zoom) parameter — without this, a
    //    bare "Hull" keyword can match Hull, Georgia (USA) just as easily as
    //    Hull, UK, since Maps search has no country/region context otherwise.
    const HULL_UK_LL = '@53.7676,-0.3274,13z'
    // NOTE: ll is sent unencoded — every SerpApi doc example does this
    // (e.g. ll=@40.7455096,-74.0083012,14z directly in the URL). Wrapping it
    // in encodeURIComponent turns "@"/"," into %40/%2C, which may not parse
    // the same way server-side. Logging the final URL below to confirm.
    const searchUrl = `https://serpapi.com/search.json?engine=google_maps&type=search&q=${encodeURIComponent(searchQuery)}&ll=${HULL_UK_LL}&google_domain=google.co.uk&gl=uk&api_key=${apiKey}`
    console.log('Google Maps search URL (key redacted):', searchUrl.replace(apiKey, 'REDACTED'))
    const searchResponse = await fetch(searchUrl)
    if (!searchResponse.ok) {
      throw new Error(`SerpApi Google Maps search failed with status ${searchResponse.status}`)
    }

    const searchData = await searchResponse.json()
    console.log('SerpApi response keys:', Object.keys(searchData))
    if (searchData.error) console.log('SerpApi error field:', searchData.error)
    console.log('local_results count:', searchData.local_results?.length ?? 0)

    const firstResult = searchData.local_results?.[0]

    if (!firstResult) {
      return new Response(JSON.stringify({ found: false, message: 'No Google Maps results found.' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log('SerpApi Google Maps firstResult raw:', JSON.stringify(firstResult))

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
      // Fallback: substring containment (handles short/possessive names like "Barley's")
      return normTitle.includes(normName) || normName.includes(normTitle)
    }

    const relevant = isRelevantMatch(firstResult.title, business_name)
    console.log(`isRelevantMatch("${firstResult.title}", "${business_name}"):`, relevant)

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
    // any result whose address doesn't look like a UK address. UK addresses
    // here should contain "Hull" and either a UK postcode pattern (starting
    // HU) or "UK"/"United Kingdom" — US addresses instead carry a two-letter
    // state code (e.g. ", GA 30646") which this pattern won't match.
    const address = firstResult.address || ''
    const looksLikeUkAddress = /\bHU\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(address) ||
      /united kingdom|\buk\b/i.test(address)

    if (!looksLikeUkAddress) {
      console.log('Rejected non-UK address:', address)
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