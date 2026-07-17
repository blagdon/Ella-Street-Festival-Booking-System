// Single source of truth for the CORS-allowed browser origin, used by every
// Edge Function's corsHeaders. Production only, deliberately - this is a
// browser-enforced protection (which origin's JS may read the response),
// not a server-side auth boundary, so it doesn't need to (and shouldn't)
// cover every possible caller. Local dev via a static file server has no
// fixed origin, so it loses browser CORS access to these functions; that's
// an accepted tradeoff, not a bug - curl/server-to-server calls are
// unaffected either way.
export const ALLOWED_ORIGIN = 'https://app.ellastreet.co.uk'
