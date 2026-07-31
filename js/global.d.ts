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
