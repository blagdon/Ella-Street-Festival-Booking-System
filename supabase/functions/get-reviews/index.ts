import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

/**
 * Extract TripAdvisor place_id from a TripAdvisor URL.
 * TripAdvisor URLs contain: -d<number>-
 */
function extractPlaceId(url: string): string | null {
  const match = url.match(/-d(\d+)-/)
  return match ? match[1] : null
}

/**
 * Clean up a Google search result title to get just the business name.
 * Strips SEO suffixes like ", Kingston-upon-Hull - 2026 Reviews & Information"
 */
function cleanTitle(rawTitle: string, fallback: string): string {
  if (!rawTitle) return fallback
  // Remove common TripAdvisor SEO suffixes
  return rawTitle
    .replace(/,?\s*Kingston[-\s]upon[-\s]Hull.*$/i, '')
    .replace(/\s*[-–|]\s*TripAdvisor.*$/i, '')
    .replace(/\s*\d{4}\s+Reviews.*$/i, '')
    .trim() || fallback
}

Deno.serve(async (req) => {
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

    // 1. Initialize Supabase client (service role bypasses RLS)
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
      return new Response(JSON.stringify({
        error: 'SerpApi API Key not configured. Please configure it in System Settings.'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 3. Use Google Search to find the TripAdvisor UK listing for the business.
    //    This is far more reliable for small/local venues than the TripAdvisor search engine.
    const googleQuery = `site:tripadvisor.co.uk "${business_name}" Hull`
    const googleUrl = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(googleQuery)}&gl=uk&hl=en&num=5&api_key=${apiKey}`

    const googleResponse = await fetch(googleUrl)
    if (!googleResponse.ok) {
      throw new Error(`SerpApi Google search failed with status ${googleResponse.status}`)
    }

    const googleData = await googleResponse.json()
    const googleResults: any[] = googleData.organic_results || []

    // 4. Find the first result that is a TripAdvisor review page (restaurant or attraction)
    const taResult = googleResults.find(r => {
      const link = (r.link || '').toLowerCase()
      return link.includes('tripadvisor.co.uk') &&
        (link.includes('restaurant_review') || link.includes('attraction_review') || link.includes('_review'))
    })

    if (!taResult) {
      return new Response(JSON.stringify({
        found: false,
        message: `"${business_name}" does not appear to be listed on TripAdvisor.`
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 5. Extract the TripAdvisor place_id from the URL
    const taUrl = taResult.link
    const placeId = extractPlaceId(taUrl)

    if (!placeId) {
      return new Response(JSON.stringify({
        found: false,
        message: `Found a TripAdvisor page but could not extract place ID.`
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 6. Fetch TripAdvisor reviews using the place_id
    const reviewsUrl = `https://serpapi.com/search.json?engine=tripadvisor_reviews&place_id=${placeId}&tripadvisor_domain=www.tripadvisor.co.uk&api_key=${apiKey}`
    const reviewsResponse = await fetch(reviewsUrl)

    let reviewsList: any[] = []
    let rating: number | null = null
    let reviewsCount: number | null = null
    const title = cleanTitle(taResult.title, business_name)
    const thumbnail: string | null = taResult.thumbnail || null

    if (reviewsResponse.ok) {
      const reviewsData = await reviewsResponse.json()
      reviewsList = reviewsData.reviews || []

      // The overall rating/count come from search_information
      const searchInfo = reviewsData.search_information || {}
      rating = searchInfo.rating || null
      reviewsCount = searchInfo.total_results || null
    }

    // Map SerpApi review fields to a clean consistent shape
    const reviews = reviewsList.slice(0, 3).map((rev: any) => ({
      title: rev.title || '',
      comment: rev.snippet || rev.text || '',
      rating: rev.rating || null,
      date: rev.date || '',
      author: rev.author?.display_name || rev.author?.username || 'Anonymous',
      link: rev.link || null,
    }))

    return new Response(JSON.stringify({
      found: true,
      title,
      place_id: placeId,
      ta_url: taUrl,
      rating,
      reviewsCount,
      thumbnail,
      reviews,
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