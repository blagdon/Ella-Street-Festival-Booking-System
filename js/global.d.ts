// Ambient globals that exist at runtime but aren't declared anywhere: both
// are loaded via a plain <script> tag rather than an ES module import, so
// there's no JS source for tsc to infer their shape from.
interface Window {
  // Set by supabase-public.js (a non-module script, loaded before any
  // js/*.js module) on every public/pre-auth page. Genuinely optional even
  // where it's read: pages that read it either check for it first or are
  // only ever reached after it's guaranteed to have run.
  ESF_PUBLIC_CONFIG?: Record<string, any>;
  // The Supabase JS SDK's UMD global, present only when loaded via CDN
  // <script> rather than as an ES module - see supabase.js's own
  // `typeof supabase === 'undefined'` fallback check.
  supabase?: any;
}

declare const supabase: any;

// Cloudflare Turnstile's widget API, loaded via a dynamically-injected
// <script src="https://challenges.cloudflare.com/turnstile/v0/api.js">
// (page-cancel.js/page-pay.js/page-food-booking.js/page-general-booking.js) -
// never imported, so `typeof turnstile !== 'undefined'` is the only way any
// of them can check it's actually loaded before calling .reset()/.render().
declare const turnstile: any;

// Leaflet (map.js) and Chart.js + its datalabels plugin (stats.js) - both
// loaded via CDN <script> tags in the pages that use them, never imported as
// modules, so tsc has no declaration for either without this.
declare const L: any;
declare const Chart: any;
declare const ChartDataLabels: any;
