// Minimal correctness-only lint net for the vanilla-JS frontend and Node
// tooling. No style/formatting rules (quotes, semicolons, indentation) -
// this repo has no formatter and applying one now would produce a
// repo-wide diff unrelated to any real bug. The goal is just the backstop
// a type system would otherwise give: undefined variables, unused
// variables/imports, and the other footguns @eslint/js's recommended set
// catches (no-dupe-keys, no-fallthrough, no-const-assign, etc.).
//
// Deliberately excludes supabase/functions/** - those are Deno/TypeScript,
// a different runtime and module resolution model than this Node-based
// ESLint setup covers. `deno lint` is the right tool there, not this file.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'css/output.css',
      'js/vendor/**',
      'supabase/functions/**',
      'supabase/sql-archive/**',
      'supabase/.temp/**',
      '.claude/**',
    ],
  },

  js.configs.recommended,

  // Browser ES modules: js/, and the root-level public/legacy scripts that
  // are loaded the same way (<script type="module">).
  {
    files: ['js/**/*.js', 'supabase-public.js', 'email_templates.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Loaded via <script src="..."> in the HTML pages that use them,
        // not imported - see kanban.js/summary.js (dragula, Quill),
        // stats.js (Chart), map.js (L / Leaflet), page-cancel.js and
        // page-food-booking.js (turnstile, loaded dynamically).
        Chart: 'readonly',
        ChartDataLabels: 'readonly',
        dragula: 'readonly',
        Quill: 'readonly',
        L: 'readonly',
        turnstile: 'readonly',
        // js/vendor/supabase.js (vendored SDK, loaded via <script src>,
        // not imported) attaches this - see supabase.js's own
        // `typeof supabase === 'undefined'` CDN-fallback guard.
        supabase: 'readonly',
      },
    },
    rules: {
      // Catches a real, common class of bug (a renamed/removed function
      // whose import was left behind) without blocking on function args
      // kept for a stable callback signature.
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },

  // Service worker: its own global scope (self, caches, clients), not the
  // window/document browser scope above.
  {
    files: ['sw.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },

  // Node-run ESM: Vercel serverless function, dev/test tooling.
  {
    files: ['api/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.mjs', 'playwright.config.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },

  // Playwright specs: Node-run test files, but every one of them also has
  // page.evaluate(() => { ... }) callback bodies that execute in the browser,
  // not Node - hence both global sets merged, rather than the plain Node set
  // every other tooling file above gets.
  {
    files: ['e2e/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },

  // Node ESM config files.
  {
    files: ['postcss.config.js', 'tailwind.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
