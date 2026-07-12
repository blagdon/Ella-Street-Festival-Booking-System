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

    // 2. Fetch SerpApi key from Env or settings table
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

    // 3. Search TripAdvisor for the business
    const searchUrl = `https://serpapi.com/search.json?engine=tripadvisor&q=${encodeURIComponent(searchQuery)}&api_key=${apiKey}`
    const searchResponse = await fetch(searchUrl)
    if (!searchResponse.ok) {
      throw new Error(`SerpApi search request failed with status ${searchResponse.status}`)
    }

    const searchData = await searchResponse.json()
    const firstResult = searchData.organic_results?.[0]

    if (!firstResult) {
      return new Response(JSON.stringify({ found: false, message: 'No TripAdvisor results found.' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // TEMP DEBUG: log the raw first result and match decision BEFORE any
    // early return below, so we can see what happened even on a rejection.
    console.log('SerpApi firstResult raw:', JSON.stringify(firstResult))

    // Guard against a confident-looking but wrong match. A plain substring
    // check would let a short name like "Noos" match unrelated results such
    // as "Noosa Ferry & Cruise Co" — require at least one shared whole word
    // (3+ letters) between the business name and the result title instead.
    const normalizeForMatch = (s: string) =>
      (s || '').toLowerCase().replace(/[-'’]/g, ' ').replace(/\s+/g, ' ').trim()

    const isRelevantMatch = (resultTitle: string, name: string) => {
      const titleWords = new Set(normalizeForMatch(resultTitle).split(' ').filter(w => w.length > 2))
      const nameWords = normalizeForMatch(name).split(' ').filter(w => w.length > 2)
      return nameWords.some(w => titleWords.has(w))
    }

    const relevant = isRelevantMatch(firstResult.title, business_name)
    console.log(`isRelevantMatch("${firstResult.title}", "${business_name}"):`, relevant)

    if (!relevant) {
      return new Response(JSON.stringify({
        found: false,
        message: `No confident TripAdvisor match found for "${business_name}".`
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const place_id = firstResult.place_id
    const title = firstResult.title
    const thumbnail = firstResult.thumbnail
    const location = firstResult.location

    // Defensive extraction: try the most likely field names/paths for rating and
    // review count, since these vary depending on result type (business vs listing).
    const rating =
      firstResult.rating ??
      firstResult.average_rating ??
      firstResult.rich_snippet?.top?.detected_extensions?.rating ??
      null

    const reviewsCount =
      firstResult.reviews ??
      firstResult.num_reviews ??
      firstResult.review_count ??
      firstResult.rich_snippet?.top?.detected_extensions?.reviews ??
      null

    // 4. Fetch the actual reviews using TripAdvisor Reviews API
    let reviewsList = []
    if (place_id) {
      const reviewsUrl = `https://serpapi.com/search.json?engine=tripadvisor_reviews&place_id=${place_id}&api_key=${apiKey}`
      const reviewsResponse = await fetch(reviewsUrl)
      if (reviewsResponse.ok) {
        const reviewsData = await reviewsResponse.json()
        reviewsList = reviewsData.reviews || []
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