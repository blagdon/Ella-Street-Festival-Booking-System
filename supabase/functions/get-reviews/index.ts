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

    // 3. Search Google Maps for the business via SerpApi
    const searchUrl = `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(searchQuery)}&api_key=${apiKey}`
    const searchResponse = await fetch(searchUrl)
    if (!searchResponse.ok) {
      throw new Error(`SerpApi Google Maps search failed with status ${searchResponse.status}`)
    }

    const searchData = await searchResponse.json()
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