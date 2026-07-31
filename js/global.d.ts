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

// dragula (drag-and-drop) and Quill (rich-text editor), both loaded via CDN
// <script> in kanban_m.html/summary.html - never imported.
declare const dragula: any;
declare const Quill: any;

interface Window {
  // Assigned by kanban.js so its own inline onclick handlers (rendered via
  // innerHTML, so they can't close over a module-scoped function) can call
  // back into it - see kanban.js's own comment at the assignment site.
  cancelDrag?: () => void;

  // summary.js's entire public surface for page-summary.js: unlike kanban.js
  // (one window assignment, everything else a normal ES export), every one
  // of these is ONLY ever assigned to window, never exported - page-summary.js
  // calls all of them as window.X(), so that's the only contract that exists
  // to type. Loosely typed (any) rather than per-function signatures: the
  // point here is unblocking the type-vs-EventTarget errors these calls
  // trigger in page-summary.js, not modelling summary.js's internals.
  filterTable?: any;
  sortTable?: any;
  setSortOption?: any;
  closeModal?: any;
  saveNote?: any;
  changeStatus?: any;
  finalizeConfirm?: any;
  resendPaymentRequestAction?: any;
  openRejectModal?: any;
  confirmRejection?: any;
  openCancelModal?: any;
  confirmCancellation?: any;
  openEmailModal?: any;
  sendSystemEmail?: any;
  emailAllConfirmed?: any;
  sendBulkEmail?: any;
  exportCSV?: any;
}
