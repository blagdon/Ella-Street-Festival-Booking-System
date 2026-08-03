# Changelog

All notable changes to this project are documented in this file.

## [7.20.0] - 2026-08-03

### Added

- **Epic 3 Platform Provisioning Suite**: Completed self-service organisation onboarding (`provisioning.html` and `js/page-provisioning.js`) backed by the `provision-organisation` Edge Function and `rpc_initialise_tenant_defaults` database RPC.
- **Event Lifecycle Status Constraints**: Added `events.status` constraint (`draft`, `ready`, `open`, `closed`, `archived`) and public booking submission guards in `submit-booking` Edge Function.
- **Automated Rollback Cleanup**: Added rollback cleanup handling in `provision-organisation` to purge partially created tenant data if provisioning fails mid-pipeline.
- **Runtime Active Event Resolution**: Dynamic event context resolution via `js/event-service.js` with active organisation and event header dropdown selectors (`js/nav.js`).
- **Comprehensive Epic 3 Testing Suite**: Expanded `tests/phase3-provisioning.test.mjs` integration tests and Playwright E2E suite (`e2e/provisioning.spec.mjs`).

## [7.19.0] - 2026-08-01

### Added

- **Platform Administration Workspace (`admin.html` & `js/page-admin.js`)**: Single-page administrative workspace featuring sidebar section routing across Platform Dashboard, Organisation Settings, Events Administration, Member Management, Branding, Categorised Settings, and Audit Logs.
- **Modular Platform UI Component Library (`js/platform/`)**: Reusable ESM component system providing standardized layouts (`layout.js`), stat cards (`cards.js`), form fields & save bars (`forms.js`), data tables (`tables.js`), focus-trapped dialog drawers (`dialogs.js`), section sub-navigation (`navigation.js`), toasts & banners (`notifications.js`), and loading skeletons (`loading.js`).
- **Current Event Service (`js/event-service.js`)**: Decouples runtime active event resolution behind `getCurrentEvent()`, `setCurrentEvent()`, `fetchAvailableEvents()`, and event change listeners.
- **Header Event Selector (`js/nav.js`)**: Added dynamic Event Selector dropdown in the admin navigation header allowing staff to switch active festival context seamlessly.
- **Categorised Settings Hub & Branding**: Tabbed settings categories (General, Bookings, Comms, Payments, Advanced) and organisation branding configuration supporting composite PK `(org_id, key)` on `settings`.

## [7.18.0] - 2026-08-01

### Added

- **Incremental type-checking via `jsconfig.json` + `tsc --noEmit`** (`npm run typecheck`, wired into CI as its own `typecheck` job, and now also a required status check on `main` alongside the other 6). `checkJs` is off by default; a file only gets checked once it adds its own `// @ts-check` comment, which works independently of that setting. Opted in the first three: `js/api.js`, `js/audit.js`, `js/ui.js`. This wasn't a no-op scaffold — it found real issues on the first run: three `updatePayment`/`updateBookingDetails`/`insertMiscBooking` functions were typed as taking a bare `@param {object} payload`, which is worse than no type at all since it hides the real shape and lets `payload.anything` through silently; given real shapes instead. `recordRefund` was passing a `number|string` straight to `parseFloat` (works today via JS's implicit coercion, but not type-correct — now explicitly `String(...)`'d first). `trapFocus()`'s `getFocusable()`/`release()` were calling `.focus()`/`.blur()` on values typed as the generic DOM `Element`, which doesn't have those methods (only `HTMLElement` does) — fixed with a real `instanceof HTMLElement` runtime check in the two release-time call sites (an actual improvement over the duck-typing check it replaced) and an explicit `NodeListOf<HTMLElement>` type for the querySelectorAll result. Verified nothing here changed runtime behaviour: `tests/refunds.test.mjs` (23/23) and the focus-trap Playwright suite (all 3) re-run clean after the edits.
- **Extended `// @ts-check` coverage from 40 files to all 57 — every `.js` file under `js/` now typechecks clean.** Covers the remaining large/high-traffic files (`kanban.js`, `payments.js`, `summary.js`, `page-hcc-dashboard.js`, `page-summary.js`, `page-food-booking.js`, `page-general-booking.js`, `js/settings/system.js`/`zoho.js`/`costs.js`/`bank-transfer.js`, `settings/stripe.js`) plus 8 trivial files that already passed cleanly under the general scan but hadn't opted in yet. `js/global.d.ts` gained the remaining CDN-script globals these files touch (`dragula`, `Quill`) and a `window.cancelDrag`/17-function `window.X` block for `summary.js`'s entire public surface — unlike every other module here, `summary.js` never exports normally; page-summary.js calls everything through `window.filterTable()`, `window.sortTable()`, etc., so those had to be declared for the type-vs-`EventTarget` errors in the *caller* to resolve. `jsconfig.json` deliberately still doesn't flip `checkJs` to `true`: `supabase-public.js` (imported by several `js/*.js` files but living outside the `js/` tree) isn't opted in and doesn't yet pass, and `checkJs: true` would force-check every such dependency's internals, not just its call-site signature — the per-file pragma stays the actual mechanism, it just now covers 100% of `js/` rather than being partial. Verified: 239/239 integration tests, both Playwright suites (31 tests) clean, lint clean, plus manual browser click-dispatch verification of every real `instanceof` behaviour change this batch introduced (`payments.html`'s resend/bank-transfer buttons, `kanban_m.html`'s close-modal delegation).
- **Extended `// @ts-check` coverage from 24 files to 40** (`js/settings/stripe.js`/`sms.js`, `page-sms-admin.js`, `page-kanban.js`, `page-manage-users.js`, `page-steward-login.js`, `page-cancel.js`, `page-pay.js`, `page-login.js`, `page-email-admin.js`, `page-location-admin.js`, `page-add-misc.js`, `stats.js`, `map.js`, `shared.js`, `locations.js`, plus `ui.js`). `js/global.d.ts` gained four more CDN-script globals that had been silently blocking every file that touches them: `window.sbClient` (see below — turned out to be dead), Cloudflare Turnstile's `turnstile`, Leaflet's `L`, and Chart.js/`ChartDataLabels`. Two real, pre-existing type-vs-reality gaps found and fixed rather than papered over: `ui.js`'s `notifyIfTruncated()` was typed as only accepting a `fetchCapped()`-shaped array, but `locations.js` legitimately calls it with a plain summary object (`{ truncated }`) after combining three separate capped fetches — the function only ever reads `.truncated`, so the type was needlessly narrow, not the caller wrong; widened to accept either shape. And `locations.js`'s own `setSort(field, direction)` took untyped params even though every real caller only ever passes one of the sort `<select>`'s literal option values (`'business'|'id'`, `'asc'|'desc'`) — typed to match, which also caught that `currentSortField`/`currentSortDir` needed the same literal-union type at their own declarations to keep it, not just at the function boundary. Also found and removed genuine dead code while chasing a "cannot find name" error: `page-steward-login.js`'s `(typeof window.sbClient !== 'undefined') ? window.sbClient : getSupabaseClient()` fallback — `window.sbClient` is never assigned anywhere in the codebase, so that branch was always false; simplified to just `getSupabaseClient()` rather than inventing a fake ambient declaration for a global that doesn't exist. Verified: 239/239 integration tests, both Playwright suites (31 tests total) clean, plus manual browser click-dispatch verification of every real `instanceof` behaviour change (`location_admin.html`'s show-add-select/open-location-sheet buttons, `stats.html`'s collapsible panels).
- **Extended `// @ts-check` coverage from 3 files to 24** (`js/api.js`/`audit.js`/`ui.js` plus `supabase.js`, `config.js`, `nav.js`, `details.js`, `message-templates.js`, `page-more.js`, `page-booking-forms.js`, `auth-init.js`, `page-comms-admin.js`, `page-message-queue.js`, `page-audit-log.js`, `page-email-queue.js`, `page-sms-queue.js`, `page-index.js`, `page-steward.js`, `page-visitor-map.js`, `page-contact-link.js`, `google-reviews.js`, `fsa-ratings.js`). New `js/global.d.ts` declares the two runtime globals that reach every module without an import — `window.ESF_PUBLIC_CONFIG` (set by `supabase-public.js`, a non-module `<script>`) and the Supabase SDK's UMD `supabase` global — so `supabase.js`'s own `typeof supabase === 'undefined'` CDN-fallback check finally type-checks instead of erroring on every file that reads either one. `initAdminPage()`'s JSDoc had both parameters as required even though the function body already treated `initCallback` as optional (`typeof initCallback === 'function'`) — three trivial pages (`page-more.js`/`page-booking-forms.js`/`auth-init.js`) call it with zero arguments, which is exactly how a stale, too-strict type first earns its keep: fixed the JSDoc to match the real, already-optional behaviour, which by itself unblocked all three files. By far the most repeated pattern (29 sites across 16 files): a delegated `document.body.addEventListener('click', e => ...)` handler calling `e.target.closest(...)`, where `e.target` is typed `EventTarget` and `.closest` only exists on `Element` — every site now narrows once at the top of its handler (`const target = /** @type {Element} */ (e.target)`) and, where the matched result is used as a button/element rather than just tested for truthiness, an `instanceof HTMLElement`/`HTMLButtonElement` check replaces the old bare truthy check (a real, verified-safe behaviour change, not just an annotation — confirmed via real click-dispatch in the browser against `kanban_m.html` nav, `message_queue.html`'s tab switch, and `audit_log.html`'s filter-target button, plus the full 239-test integration suite and both Playwright suites, all clean). The rest is the same `document.getElementById(id).value/.disabled/.options` pattern already fixed in `js/ui.js` above, applied file-by-file: `<input>`/`<select>` casts for search boxes and filters, `<button>` casts for load-more/retry/save buttons. The remaining ~30 files (`kanban.js`, `payments.js`, `summary.js`, the `js/settings/*.js` split, the booking forms, etc.) are still on `checkJs: false` with no `// @ts-check` — same incremental, opt-in-when-ready approach as the first three, not a blanket requirement.
- **`enforce_admins` turned on for `main`'s branch protection.** Combined with making all 6 CI jobs required status checks (see the entry below from a previous round), this closes the last gap in that work: previously, `enforce_admins` being off meant the CI rigor was opt-in for whoever has admin/bypass rights on this repo specifically — the required-checks-on-`main` protection only ever actually applied to a hypothetical non-admin contributor.

### Testing

- **Retry logic had been treating every Edge Function 502/503/504 the same way regardless of where it happened: silently re-running the entire 239-test suite from the top, twice, with no delay.** That papered over the actual failure without addressing it at the point it happens. `tests/helpers.mjs` now exports `fetchEdgeFunction`/`callEdgeFunction`, a shared fetch wrapper that retries up to twice with backoff, but *only* on 502/503/504 — any other status (including a real 500 from inside the function) returns immediately, so a genuine bug still fails on the first try rather than getting a free pass. This also happened to be the same repeated pattern flagged in `CLAUDE.md`'s sweep-habit section: 9 test files (`bank-transfer-payment`, `integration`, `stripe-payment`, `public-error-sanitisation`, `email-retry`, `google-reviews-cache`, `sms-delivery-status`, `sms-send`, `sms-test-mode`) each independently defined their own near-identical `callFunction`/`callRetry`/`callSend`-style wrapper around the exact same raw `fetch(.../functions/v1/...)` call; 3 more (`cors`, `refunds`, `workflow`) inlined it without even a wrapper. All 12 now delegate to the shared helper. The outer CI-level retry loop (`integration-tests` job) stays as a second line of defence for whatever the per-request retry can't catch, but now sleeps 20s before its retry instead of immediately re-hitting a project that just proved unhealthy. Verified with a full local run: 239/239 pass, `npm run lint` and `npm run typecheck` clean.
- **Extended coverage and hardened the CI safety net, on top of the Playwright suite added above.**
  - **Retry the integration-tests job once on failure.** Same convention as `scripts/check-rls-grants-snapshot.sh`'s own dump-attempt loop. `integration-tests` is a required status check, and a transient 502 from the shared test Supabase project (hit live, repeatedly, on a different test each time this session — never a real regression) shouldn't be able to block a merge by itself; a genuine failure still fails the job, it just has to happen twice in a row first.
  - **Shared test helpers.** Every one of `tests/`'s 17 files independently repeated the same ~15-line block (reading `.env.test`, the "refuse to run against anything but the disposable test project" guard, and the service-role client). Extracted into `tests/helpers.mjs`; each file now imports it instead. Deliberately left each file's own anon-key client variable (`anon`/`authed`/`admin` — naming varies) and admin sign-in untouched, since forcing one shape there would cost more churn than the duplication it removed. Verified node's test runner still ignores the new file (no `.test.` in its name) and the full suite is unaffected.
  - **Two previously-untested workflows.** `tests/rejection.test.mjs`: rejecting a booking had zero coverage despite being at least as common an admin action as a refund — covers the status/reason update, the rejection email (genuinely invoked against this project's deliberately-unconfigured Zoho, same "the failure IS the assertion" principle as `email-retry.test.mjs`), and the audit log row. `tests/location-email.test.mjs`: `queueLocationEmail()` (`js/shared.js`) is a real, shipped feature that had never been exercised — seeds its own `location_update` email template (not one of the four `scripts/seed-test-project.mjs` already ensures) and covers the same email-queue/audit-log mechanism. Both caught one real, pre-existing fact about this schema while being written: `audit_logs.details` is `TEXT`, not `JSONB` (the recommendation declined earlier in this changelog), so reading it back needs `JSON.parse()` — already true elsewhere (`stripe-payment.test.mjs`), just not obvious until a new test tried to read it directly.
  - **Phase 3 of the Playwright suite: automated focus-trap regression checks** (`e2e/focus-trap.spec.mjs`) — the Tab/Shift+Tab-wrapping and focus-restore-on-close behaviour added earlier in this changelog had only ever been verified once, by hand. Covers the shared `showConfirm` dialog, a real modal with a focusable trigger (`payments.html`'s edit modal), and a modal opened from a non-focusable trigger (a kanban card) — the exact case that surfaced the stranded-focus bug fixed alongside `trapFocus()` itself. Seeds its own fixture booking rather than depending on whatever data happens to already exist in the shared test project. Found and fixed two real bugs in the test infrastructure itself while stabilizing this: (1) the three focus-trap tests share one mutable fixture via file-level `beforeAll`/`afterAll`, which is unsafe under this config's `fullyParallel: true` — Playwright can shard one file's tests across workers, and one worker's cleanup deleting the fixture mid-test for another was an intermittent, hard-to-reproduce-in-isolation failure; fixed with `test.describe.configure({ mode: 'serial' })`. (2) Both accessibility spec files used `page.waitForLoadState('networkidle')` to wait out async rendering (nav injection, data fetches) — safe for the 17 admin pages (confirmed none hold a live connection), but `pay.html`/`cancel_booking.html` keep a live Turnstile connection open, which networkidle never considers idle, so it just timed out after 30s. Fixed with `'load'` plus, for `visitor_map.html` specifically, a targeted wait for Leaflet's attribution control (which renders and gets its final styling after `'load'` fires — scanning any earlier caught a real but transient contrast violation in its intermediate, unstyled state).
  - **All 6 CI jobs are now required, branch-protected status checks on `main`** (previously only `integration-tests` — `rls-grants-check` had been silently failing across 12 consecutive pushes with nothing to stop it, exactly the gap this closes). `enforce_admins` deliberately left off: that would additionally block direct pushes (not just PRs) pending a green CI run, a bigger behavioural change than what was asked for here.

### Fixed

- **`#passwordResetModalDesc`'s `text-gray-500` sat right at the edge of the 4.5:1 contrast threshold (measured 4.32-4.5:1 across different runs)** — close enough that font-rendering/anti-aliasing precision could flip the automated test pass/fail from run to run, which is exactly what happened while re-verifying the suite for an unrelated review. Not a flaky test: a genuinely borderline colour that was never given the safety margin every other `text-gray-400`/`text-gray-500` fix in this changelog already got. Bumped to `text-gray-600`, same as everywhere else; confirmed stable across several re-runs afterward.
- **The mandatory password-reset gate (`index.html`'s `#passwordResetModal`, shown when an admin follows a Supabase password-recovery link) had never been wired into either the focus-trapping or ARIA work below.** Found by grepping every `*Modal`-style element id across the app after being asked "any other gaps?" rather than assuming the earlier per-file review had already caught everything — this one was reachable through neither round: `js/page-index.js` shows it via a special pre-auth code path that runs before the normal admin dashboard even initialises, not through `js/kanban.js`/`js/summary.js`/`js/payments.js`'s shared modal machinery. Genuinely different from every other modal in the app, not just an oversight of the same kind: it has no close button and no Escape handling by design — the rest of the page is deliberately hidden behind it, and it's only ever left by completing the password change (which navigates to `login.html`) or reloading, so there's nothing to "cancel" back to. Added `role="dialog"`/`aria-modal`/`aria-labelledby`/`aria-describedby`, a `<label>` for the password field (previously placeholder-only), and `trapFocus()` on show — deliberately without the Escape/`registerModalClose` half other modals get, since dismissing this one would defeat its purpose. Added `e2e/accessibility.spec.mjs` coverage for this exact state (no admin session needed — it's reachable pre-auth) so it can't regress unnoticed again.
- **Escape didn't close `summary.html`'s Booking Details panel or its other 5 modals** (bulk email, compose email, reject reason, cancel booking, confirm type) — reported live immediately after the focus-trapping work below shipped. Root cause: `summary.js` has its own separate `closeModal`, never wired into `js/ui.js`'s shared Escape-key registry the way `kanban_m.html`'s identical-looking modals already were (a gap I'd actually flagged to myself while adding focus trapping to this exact file, then left for the trapping work alone rather than expanding scope — should have just fixed it there). Now registers/unregisters through `registerModalClose` at the same point focus-trapping already hooks in, mirroring `kanban.js`'s pattern exactly.
- **Accessibility: focus trapping for every modal in the admin app.** Opening any modal now moves focus into it, Tab/Shift+Tab cycles within it instead of escaping to the page behind, and closing it (via button, overlay, or Escape) returns focus to whatever triggered it — the last item on the manual-review list, via a new `trapFocus()` in `js/ui.js` wired into all 20 modals: `showConfirm`'s shared dialog, the 6 modals each on `kanban_m.html`/`summary.html` (detail panel, bulk email, compose email, reject reason, cancel booking, confirm type), `payments.html`'s 4 (edit, bank transfer, refund, resend payment), `location_admin.html`'s email modal and mobile location sheet, the email/SMS template preview modals, and `steward.html`'s edit modal. Caught one real bug while verifying with actual Tab keypresses (a `.focus()` call doesn't reliably reproduce this, same lesson as the earlier focus-visible check): several modals hide via `opacity-0`/`pointer-events-none` rather than `hidden`, so they never leave the layout — closing one whose trigger was a plain clickable card `<div>` (not natively focusable) left keyboard focus stranded on a now-invisible control inside it instead of the browser's usual auto-blur-on-`display:none`. `trapFocus()`'s release function now explicitly blurs if focus is still inside the modal after attempting to restore it, so this can't happen regardless of what kind of element triggered the dialog.
- **Accessibility: manual-review follow-ups beyond what axe-core catches on its own** — screen-reader announcements, dialog semantics, and table structure. `showToast` (`js/ui.js`), the one shared feedback mechanism already used for every "Booking saved"/"Refund completed"/"Email queued"-style message across the app, had no ARIA on it at all — a screen reader user got nothing when one fired. It now sets `role="alert" aria-live="assertive"` for errors and `role="status" aria-live="polite"` otherwise, picked from the existing `type` parameter, so this one change fixes announcements at every call site. `showConfirm`'s shared confirmation dialog — used for every destructive-action prompt (refunds, deletions) — gained `role="dialog" aria-modal="true" aria-labelledby="confirmTitle" aria-describedby="confirmMessage"`, using ids the markup already had sitting unused. `payments.html`'s modals had `role="dialog"`/`aria-modal`/`aria-labelledby` from an earlier pass but no `aria-describedby`; added it to the three that have a description element (bank-transfer, resend-payment, refund) — `edit-modal` has no description text, so nothing to point it at. And every plain data table's `<th>` (`audit_log.html`, `hcc_dashboard.html`, `location_admin.html`, `message_queue.html` ×2, `summary.html` — 48 headers total) gained `scope="col"`; `payments.html`'s table already had it. Checked but left alone: status badges already pair colour with the status word itself, not colour alone, so no change needed there; skip links and full focus-trapping for modals (`Tab`/`Shift+Tab` wrapping, focus return on close) are still open as a larger follow-up.
- **Accessibility: extended the axe-core audit to all 19 admin-only pages.** Same methodology as the public-page rounds above, run against every admin HTML file plus `steward.html`/`steward_login.html`. Most of the volume traced back to three shared components, each fixed once: `js/nav.js`'s `#instanceSelect`/`#instanceSelectMobile` had no accessible name (critical, present on every admin page that uses the nav bar) and its "`| 2026 Admin`" subtitle used `opacity-50` for de-emphasis, which pushed contrast to 3.4:1 (now a plain `text-gray-600`, no opacity); a footer div copy-pasted onto `index.html`/`booking_forms.html`/`more.html`/`settings.html` used `text-gray-400`; and the bulk-email modal + its hand-authored Quill toolbar (shared by `kanban_m.html`/`summary.html`) had 7 icon-only formatting buttons and 2 modal-close buttons with zero accessible name, plus two `<input>`/`<textarea>` pairs missing `for`/`id` label associations. Beyond the shared fixes: `login.html`'s email/password fields had no label at all (critical, no placeholder fallback either); `steward_login.html`/`steward.html` disabled pinch-zoom via `user-scalable=0` in their viewport meta tag (critical, `meta-viewport` rule) and used a light-blue-on-blue and white-on-bright-green combination that both failed 4.5:1; `update_details.html` (Booking Editor) had 13 unlabeled form controls — the single worst page in the audit; `location_admin.html` and `payments.html` each had one icon-only button with no label; and eight pages had a `<select>` filter/sort control with no accessible name. The remaining bulk of individual findings were the same `text-gray-400`-on-light-background contrast failure already fixed on the public pages, this time in `settings.html` (~28 occurrences across every settings card, plus 3 links that were only distinguishable from surrounding text by colour — same `link-in-text-block` fix as the payment pages above) and repeated per-tab-panel in `stats.html`. `stats.html` needed the same temporary-CSP-loosen-then-revert technique as the public payment pages, since it's the one admin page whose CSP doesn't already allow `cdnjs.cloudflare.com` (confirmed via `git diff` that the revert was exact). Re-ran axe-core on every page after fixing: zero violations everywhere.
- **Accessibility: extended the axe-core audit to four more public pages** (`visitor_map.html`, `pay.html`, `payment_success.html`, `payment_cancelled.html`) — all reachable by members of the public with no staff-assisted alternative, same justification as the booking forms above. `visitor_map.html`'s icon-only locate-me button and category filter `<select>` had no accessible name (both critical); added `aria-label`s. All three payment-flow pages had the same `text-gray-400` contrast failure as before; `payment_success.html`/`payment_cancelled.html`'s "contact us" link also failed contrast on its own (`text-blue-500`, 3.7:1) and — the colour-blindness-relevant part — was only underlined on `:hover`, so in its static state it was distinguishable from the surrounding text *only* by colour (`link-in-text-block`). Both pages' link darkened to `text-blue-700` with a permanent underline, matching the convention already used elsewhere on these same pages. `pay.html`/`payment_success.html`/`payment_cancelled.html` don't allow `cdnjs.cloudflare.com` in their (correctly tighter) CSP, unlike the booking forms — verified by temporarily loosening each one to run axe-core, then reverting before committing (confirmed via `git diff` each time). Also checked `visitor_map.html`'s category markers for colour-only distinction: each category already gets a genuinely different SVG icon shape (burger, musical note, toilet symbol, etc.), not just a recoloured pin — no fix needed there. Re-ran axe-core on all four after fixing: zero violations everywhere.
- **Accessibility: colour-only validation state on the public booking forms.** `Food_Stall_booking.html`/`General_Booking.html`'s red-invalid/green-valid field styling (`:user-invalid`/`:user-valid`) relied on colour alone — confirmed via a deuteranopia/protanopia simulation that the two collapse to the same pale tan and become indistinguishable. Added a cross/tick SVG icon alongside the existing colour (right side for text inputs, left side for `<select>`s to avoid colliding with the native dropdown arrow; checkboxes/radios/file inputs excluded, since they already have their own "checked" affordance and are too small for a corner icon). Re-ran the same colour-blindness simulation after the fix: the icon shapes stay unambiguous even when the border/background colours collapse into one.
- **Accessibility: the public booking forms had critical `axe-core` violations.** Ran an automated WCAG 2.1 A/AA audit (axe-core) against `Food_Stall_booking.html`, `General_Booking.html`, and `cancel_booking.html` — the forms actual members of the public use to apply, with no staff-assisted alternative. Fixed all violations found: every text field, checkbox, and `<select>` now has a properly associated `<label for>` (previously ~24 labels site-wide had no `for`/`id` link at all — some inputs had no accessible name whatsoever, flagged critical); the small gray helper text (character counters, "(optional)" hints) went from `text-gray-400`/`text-gray-500` to `text-gray-600` to clear the 4.5:1 contrast minimum; and every one of the site's 24 HTML files gained `<html lang="en">` (was missing everywhere). Re-ran the audit after fixing — zero violations on all three pages. Also disproved, rather than "fixed," an apparent focus-visibility bug the first test pass suggested: a `.focus()`-based check showed no visible focus ring anywhere, but that method doesn't trigger `:focus-visible`, which is what the ring's CSS is actually scoped to — a real Tab-key press confirmed focus indicators render correctly, so nothing there needed changing.
- **Four more review follow-ups.** A payment-link claim that was taken but never got a checkout_url stored (the Stripe API call failed, and the revert itself then also failed to run — isolate crash, network drop) no longer holds the slot for the full 24h freshness window with no self-healing path; `rpc_claim_stripe_session_slot` now has a much shorter (2 minute, configurable) lease for an unfulfilled claim specifically, bounding the worst-case stallholder lockout from 24 hours down to 2 minutes. The `ESF_SETTINGS_CACHE` sessionStorage cache (`js/config.js`, `supabase-public.js`) now carries a 5-minute TTL — it previously had none, and since sessionStorage survives a plain reload and a settings.html save only clears the *same* tab's own cache, any other already-open tab kept serving whatever it first cached until closed. `create-checkout-session` now best-effort expires the OLD Stripe Checkout Session before clearing it on a resend, so a stallholder who'd bookmarked the raw `checkout.stripe.com` URL from an earlier click can't complete payment on an outdated price after an admin corrects it and resends. And removed a vestigial, superseded JSDoc block in `js/supabase.js` left over from before `requireAuth()` took a `requiredRole` parameter.
- **A refund race: two concurrent refund attempts on the same booking could both succeed and corrupt the recorded amount.** `rpc_record_refund`'s "already refunded?" guard was a plain `SELECT` with no row lock — for a *full* refund Stripe's own ledger caught a genuine double-attempt, but two concurrent *partial* refunds that each individually fit within the original charge could both succeed for real at Stripe, then silently overwrite each other's recorded `refund_amount`/`refund_reference` here (the same class of check-then-act race already fixed for `rpc_claim_stripe_session_slot`). The RPC's `UPDATE` is now the actual atomic claim (`WHERE ... AND refund_amount IS NULL`), so only one of two concurrent calls can ever win. Reachable in the UI because the refund modal's Cancel button wasn't disabled mid-request — an admin could cancel, reopen against stale data, and refund again before the first request resolved; both Save and Cancel are now disabled for the duration of a refund.
- **Three follow-up review notes on the payment-link redesign.** `payment_link_code` now has a `NOT NULL` constraint (confirmed zero NULLs on production first) — the `DEFAULT` + backfill + app-level guard meant it *should* always be set, but nothing at the database level actually enforced it. The SMS Admin preview for `payment_requested` no longer shows the literal, unreplaced `{{payment_link}}` token (only `create-checkout-session` has the Stripe context to build the real link, so `getSmsFromTemplate` never substitutes it) — it now shows `[pay link - generated at send time]` instead, a plain-ASCII placeholder chosen so it doesn't skew the preview's own SMS-part/encoding counter. And `create-checkout-session`'s payment-request SMS now writes an `sms_sent` `audit_logs` row on a successful send, matching every other SMS path (`sendBookingSms`) — previously it only wrote to `sms_queue`, so a booking's audit trail couldn't show whether a payment request went out by text.
- **Four related "the SMS silently didn't send" bugs**, all reported live in quick succession. Chargeable-booking confirmations (both the Stripe and bank-transfer paths) never texted at all — neither `stripe-webhook` nor the bank-transfer flow had any SMS logic, unlike the free-confirm path. The Kanban/Summary confirm modal's "also text" tickbox was read but never actually passed through `confirmChargeableAndRequestPayment()`. **Resend Payment Request** had no tickbox anywhere in the UI to opt into a text, even though the server already supported one. And a stale browser cache made an already-deployed fix look broken until a hard refresh — Vercel serves JS with no cache-busting hash, so a plain reload can silently keep running pre-fix code. Fixed at each root cause; `vercel.json` now also sends `Cache-Control: no-cache, must-revalidate` so this class of "deployed but not live for this admin" bug can't recur.
- A flaky test re-run: two new SMS tests left stray `sms_queue` rows outside their file's cleanup wildcard, so a second run's exact-count assertion could fail against a first run's leftovers.
- A high-severity `postcss` advisory (XSS / path-traversal via crafted CSS), patched via `npm audit fix` (postcss → 8.5.24, transitive through nanoid). Build-time only; `css/output.css` rebuilds byte-identical, so no redeploy risk.

### Changed

- **`getEmailFromTemplate`/`getSmsFromTemplate` extracted from `js/shared.js` into a new `js/message-templates.js`.** No behavior change. Unlike the rest of `shared.js` (a genuinely cohesive module: `sharedUpdateStatus`/`populateDetailPane`/the SMS-toggle wiring are used with *identical* import lists by `kanban.js` and `summary.js`, and splitting them further would help no one), these two functions were the one real cross-cutting piece — called directly by `payments.js`, and internally by `shared.js`'s own `queueLocationEmail`/`queueLocationSms`/`maybeSendStatusSms`/`sharedUpdateStatus`. Same shape as the `auditLog` → `js/audit.js` extraction earlier in this batch. `shared.js` itself is ~180 lines shorter and no longer imports `CONFIG`/`getStallCost`, which it only ever needed for these two functions.
- **`js/page-settings.js` split into `js/settings/{stripe,sms,zoho,bank-transfer,costs,system}.js`.** No behavior change. Unlike `api.js` above, this one had exactly one consumer (`settings.html`) and zero cross-calls or shared internal helpers between its ten `initX()` functions — each owned one settings card, one set of DB keys, one save button, independently. `page-settings.js` is now a 22-line orchestrator that imports and calls all ten; `stripe.js`/`sms.js`/`zoho.js` (the three largest, ~170-195 lines each) get a file of their own, `costs.js` bundles stall costs + stall types, and `system.js` bundles the toggles/system constants/Sentry/SerpApi cards that didn't warrant their own file. Named `bank-transfer.js`, not `payments.js`, to avoid colliding with the existing `js/payments.js` (the whole Payments Dashboard page) and `api.js`'s own "Payments & Confirmation" section.
- **`js/api.js` reorganized, and `auditLog` extracted into its own module.** No behavior change. `api.js` had grown to 1066 lines / 29 exports with no internal grouping — it now has the same `// === SECTION ===` banners already used in `payments.js`/`ui.js` (Bookings, Communications, Payments & Confirmation, Locations, Stats & Dashboard, Map). `auditLog` — used by 6 files that need nothing else from `api.js` — moved to a new `js/audit.js`, so those files (and `api.js`'s own ~20 internal call sites) now depend on a small, single-purpose module instead of the whole booking/payments/comms surface. Deliberately NOT a full split into one file per domain: with no bundler in this app, that wouldn't reduce what any page downloads, several functions (`finalizeConfirmation`, `requestPayment`/`resendPaymentRequest`) genuinely straddle more than one proposed category, and most real consumers (`kanban.js`, `summary.js`) already need functions spanning 3+ of the proposed modules — splitting fully would trade one import line for several without a clear win in a solo-maintained repo.

### Added

- **Phase 2 of the automated accessibility regression suite: the 17 auth-gated admin pages.** `e2e/admin.setup.mjs` signs in once as the same disposable test-project admin `tests/*.test.mjs` already uses, and saves the resulting Playwright storage state for `e2e/admin-accessibility.spec.mjs` to reuse across all 17 pages — run via the new `npm run test:a11y:admin` / `admin-accessibility-tests` CI job, sharing `integration-tests`' shared-test-DB concurrency group since both hit the same live test project. Caught a real bug in the suite itself before it ever shipped: the "public" project's `testMatch` was an unanchored substring match, so `admin-accessibility.spec.mjs` (containing the string `accessibility.spec.mjs`) was silently also running — unauthenticated — under the no-auth "public" project. Every one of those 17 pages just redirects to `login.html` when signed out, so the suite was quietly scanning the login page 17 times over and reporting a false "all passed" with zero real coverage of any admin page. Caught by manually checking `page.url()`/`page.title()` after a run rather than trusting a green result; fixed by anchoring each project's `testMatch` to a path separator immediately before the filename.
- **Phase 1 of the automated accessibility regression suite** (`e2e/accessibility.spec.mjs`, via Playwright + `@axe-core/playwright`), CI-wired as its own `accessibility-tests` job. Every accessibility fix across the last several batches — labels, contrast, ARIA, focus trapping — was verified by hand in a browser and had nothing stopping it from silently regressing; this automates the exact axe-core scans done manually. Scoped to the 9 pages that need no authentication and no live Supabase connection (the 7 public-facing pages plus the two admin login screens) — see the entry above for phase 2, the 17 auth-gated admin pages. Runs fully independently of `integration-tests`' shared-test-DB concurrency group, since none of these pages touch it. Caught a real bug on its first run: `login.html`'s brief "Checking session..." loading state (shown while it checks for an existing session before either redirecting or showing the form) had the same `text-gray-400` contrast failure fixed everywhere else — missed by the earlier manual audit purely because that scan happened to run after the state had already flashed past.
- **CSV export presets on the Payments page.** A new "What to export" selector alongside the existing Export button: **All Records** and **Refunded Only** export every matching booking for the loaded instance regardless of whatever the status filter/search box currently show (previously the only way to get either was to first set the filter yourself); **Net Billed Summary** is a new single-row reconciliation export (Total Billed, Total Collected net of refunds, Total Refunded, Total Outstanding) for festival close-out, reusing the exact same totals already shown in the header stat tiles (`computeTotals()`, extracted from `renderTable()`) rather than a separate calculation that could drift from what's on screen. The original **Current View** behaviour (respects the filter/search) is unchanged and stays the default.
- **Escape closes admin modals.** No modal previously bound Escape at all (`js/ui.js`'s already-shared `showConfirm`/`closeConfirmModal`, plus 10 more across `js/payments.js`, `js/kanban.js`, `js/locations.js`, `js/page-steward.js`, `js/page-sms-admin.js`, `js/page-email-admin.js`, with no shared convention between them). A small registry in `js/ui.js` (`registerModalClose`) now gives every one of them Escape support from a single keydown listener — a LIFO stack, not a single "current modal" flag, since `showConfirm` is sometimes opened on top of an already-open modal (e.g. the Stripe-refund confirmation) rather than replacing it. Each modal registers its own real close function, never a raw `classList` toggle, so existing guards keep working exactly as they do from a button click — in particular, `closeRefundModal`'s refusal to close mid-request (see the refund-race fix above) is preserved rather than bypassed.
- **An unsaved-changes warning on the public booking forms** (Food Stall and Non-Food/General) — a `beforeunload` guard (`guardUnsavedForm()` in `js/utils.js`) now prompts before an accidental tab close, back-navigation, or nav-link click loses an in-progress application, which asks for business details, specs, and file attachments with no draft-save anywhere. Suppressed on a successful submit (and the subsequent "Start a new booking" reload), since neither of these forms navigate away on success — they swap in an inline success view and stay on the page.
- **A short first-party payment link** (`pay.html` + the new `get-payment-link` function) so the `payment_requested` SMS can carry a real link without a ~475-character Stripe Checkout URL eating 6-8 billed parts on its own — mirrors the `cancel_link` trick already used elsewhere. Shortened again shortly after, from the ~110-character Stripe session id to an 8-character `payment_link_code`.
- **A correctness-only ESLint setup** (`eslint.config.mjs`) — the lint net this 12.7k-line vanilla-JS frontend never had (`no-undef`, `no-unused-vars`, etc., no style/formatting rules). Its first run surfaced 29 pre-existing issues — dead code, silent empty catch blocks, a couple of direct `hasOwnProperty` calls, an unnecessary regex escape — all cleaned up in the same pass, verified against the full test suite and a manual smoke test.

## [v7.16.0] - 2026-07-27

"SMS Cancel Link and Bank Details" — a same-day follow-up to v7.15.0.

### Added

- **`{{cost}}`/`{{bank_details}}` and `{{cancel_link}}` added across SMS templates.** `booking_confirmed` now carries payment details for a stallholder who only reads texts, and every template except `booking_rejected`/`booking_cancelled` (nothing left to cancel there) carries a cancel link. A deliberate, explicit trade-off: these three templates now bill as 2 parts instead of the 1-part budget the previous release had specifically reworded them to hit.

## [v7.15.0] - 2026-07-27

"SMS Integration" — texting goes from inert scaffolding (v7.14.0 shipped with only a no-op mock provider) to a live, working feature: a real provider account, opt-in SMS across every admin action that already emails, delivery-status tracking, and audit coverage. Shipped as PRs #110–#119.

### Added

- **Live SMS sending via The SMS Works**, with a Settings card for its credentials and a **Test Mode master switch** (safe by default, seeded ON) that force-routes every send through the mock adapter regardless of the configured provider — entering real credentials can never itself cause a real send. Sent/Successful/Unsuccessful/Simulated counts added to the SMS Queue.
- **On-demand SMS delivery-status tracking.** `sms_queue.status` only ever meant "the provider's API accepted the message," not "the text reached the phone" — a real bulk send had rows marked Sent that never arrived. Adds an admin-triggered check against the provider's status endpoint. Deliberately polling, not a webhook: no signature-verification mechanism could be confirmed for The SMS Works' delivery-report callback, and a public receiver trusting an unauthenticated POST was judged not worth building without one. The result is stored for visibility only — it never changes retry eligibility.
- **Opt-in SMS added to every remaining admin action that already emails**: Compose Email and Bulk Email (Kanban/Summary), reject, cancel, and Location Manager's send/bulk-send — each with its own tickbox, defaulted off and reset on every open. Booking submission and self-service cancellation now also text automatically, with no tickbox since no admin is present to tick one — mirroring their existing auto-emails.
- **Audit logging for every SMS action** (`sms_sent`, `sms_bulk_queued`, `retry_queued_sms`), including the billed segment count and provider message id, so the audit trail can answer "why was the bill that size," not just "was it sent."

### Fixed

- **The rejection SMS never contained the admin's typed reason** — `getSmsFromTemplate()` had no `{{reason}}` substitution at all, unlike its email equivalent. Fixed, with the reason truncated to 40 characters using ASCII `...` rather than `…` — a single non-GSM-7 character would have forced the whole message into 70-char-per-part UCS-2 encoding, the opposite of what the truncation was for.
- **All three seeded SMS templates were silently billing as 2 parts instead of 1** (168-198 characters against the 160-char GSM-7 limit). Reworded to fit a single part with headroom, via a guarded migration that skips any row an admin has already hand-edited.
- **A stray Tailwind CSS bug**: the mock SMS adapter's bracket-colon log tag matched Tailwind v4's arbitrary-property syntax and emitted a junk CSS rule, because `@source` scanned the entire repository including the Deno Edge Functions. Tag renamed; `@source` narrowed to the actual templates.

### Changed

- **Email/SMS Templates and Email/SMS Queue merged into tabbed pages** (`comms_admin.html`, `message_queue.html`), replacing four near-duplicate cards on the tools index with two.

### Testing

- 21 SMS-related integration tests across four files (`sms-delivery-status`, `sms-send`, `sms-test-mode`, plus additions to `integration.test.mjs`), all run against the real deployed functions with a safety interlock that refuses to run unless the test project's provider is `mock`.

## [v7.14.0] - 2026-07-25

SMS sending, added from a feasibility study into texting stallholders. Minor bump: a genuinely new capability, but one that ships **inert** — the default provider is a no-op, so nothing is sent or billed until someone deliberately configures a real account. The whole pipeline is a deliberate mirror of the existing email queue (`email_queue` → `sms_queue`, `email_templates` → `sms_templates`, `claim_pending_emails()` → `claim_pending_sms()`, `_shared/zoho.ts` → `_shared/sms.ts`), so there is one mental model to maintain rather than two.

### Added

- **A provider-agnostic SMS sender (`supabase/functions/_shared/sms.ts`).** Dispatches on the `sms_provider` settings row to a pluggable adapter, so swapping providers is a settings change, not a code change or a redeploy. Three adapters ship: **`mock`** (the seeded default — logs and reports success, needs no account, no credentials and costs nothing, which is what lets the full queue/drain/retry/viewer path be exercised end-to-end before anyone signs up), **`thesmsworks`** (UK, pay-as-you-go, JWT auth), and **`twilio`** (Basic auth, form-encoded). Adding another is one `sendVia<Name>` function plus one switch case. Called **in-process** by all three Edge Functions rather than over HTTP, the same rule the pre-commit hook enforces for `sendViaZoho` — see `_shared/zoho.ts`'s docstring for the sibling-function failure mode that avoids.
- **`normalizePhone()` — E.164 normalisation, deliberately strict.** `bookings.phone` has no format constraint (only `performers.phone` has the `valid_phone` CHECK), so stored numbers are whatever the trader typed. Numbers are normalised to `+44…` before insert and defensively again at send time; anything that can't be confidently converted **throws** rather than being silently dropped, because a text that vanishes is worse than one that visibly fails. Only GB's trunk-`0` rule is automatic — other countries must be entered in full international form.
- **`sms_queue` and `sms_templates` tables, plus `claim_pending_sms()` (migration `20260725100000`).** Same shape, same RLS/grant model, and the same `FOR UPDATE SKIP LOCKED` batch claimer with a 15-minute self-heal as the email side. Two SMS-specific columns: **`segments`** (how many parts the body bills as) and **`provider_message_id`** (the provider's id for later reconciliation). `authenticated` gets SELECT+INSERT only — deliberately **no UPDATE** — so status transitions stay service-role/RPC only, exactly as `email_queue` was narrowed in `20260718110000`; that's why the retry action has to go through an Edge Function.
- **Three Edge Functions.** `send-sms` (single inline send, admin JWT or trusted service call), `queue-bulk-sms` (re-derives recipients server-side from Confirmed bookings, never trusts client-supplied numbers, then drains in the background via `EdgeRuntime.waitUntil` so a bulk send survives the admin closing their browser), and `retry-queued-sms` (single failed row, with the same conditional `Error → Processing` claim as the email equivalent — a delivered text is never re-sent or **re-billed**).
- **An opt-in confirmation SMS on the Kanban and Summary confirm modals.** A tickbox — "Also text the stallholder their confirmation" — defaulted **off** and reset every time the modal opens, so a ticked state never carries over to the next booking. Scoped to the **free** confirm path, which confirms then and there; the chargeable path lands on `Payment Requested` and is confirmed later server-side, hence the "free confirmations only" label. The send sits in its own try/catch alongside the confirmation email, so a texting failure never masks a successful email (or vice versa) — the same "already-committed side effect must degrade to a warning, not a rollback illusion" rule v7.12.0 established for the email itself.
- **SMS Queue viewer (`sms_queue.html`).** A clone of the Email Queue with SMS-appropriate columns: the message body collapses to a preview that expands, and carries a **billed-segment badge** (amber past one part) — because unlike email, every part costs money. Retry is offered only on `Error` rows, matching what the function enforces.
- **SMS Template Manager (`sms_admin.html`).** Mirrors the email template editor minus the subject (SMS has no subject), with a **live segment counter** that uses the same GSM-7/UCS-2 logic as `_shared/sms.ts`, so the editor's estimate matches what the sender actually records. The preview renders as a phone-style bubble via `textContent`, never `innerHTML` — an SMS is plain text, so HTML would both be wrong on the handset and an injection surface.

### Fixed

- **A stale two-argument `esfUseTestProject()` example in `scripts/dev-server.mjs` and `supabase-public.js`.** Both comments showed `esfUseTestProject('https://<ref>.supabase.co', '<anon key>')`, but the function has taken **only the anon key** since the dev-server proxy landed — the project URL comes from `TEST_SUPABASE_URL` in `.env.test` precisely so the browser can't aim it at an arbitrary project. Following the stale form stores the URL *as* the anon key, and every auth call then fails with no obvious cause. The dev server already printed the correct one-argument form on startup; the comments now agree with it.

### Notes on the feasibility study

Recorded here because they constrain what this feature may be used for, and none of it is visible from the code:

- **GOV.UK Notify is not an option.** It's the obvious cheap route, but eligibility is limited to central/local government, NHS, schools and emergency services; charities and community groups are explicitly excluded. A non-registered community association is in the commercial market.
- **No sender-ID registration is required to send.** An 11-character alphanumeric sender ID (`EllaStFest`) works without registering. The MEF SMS SenderID Protection Registry is **voluntary** and fee-based, aimed at limited companies protecting a brand from spoofing. The tradeoff is that an alphanumeric ID is **one-way** — recipients can't reply — so every template must carry a contact route in the body, which the seeded one does.
- **Keep it to service messages.** Booking confirmations and payment reminders are transactional messages to someone who supplied their number for exactly that purpose, so no prior opt-in is needed under PECR. **Marketing** ("come to next year's festival") is a different legal test and needs consent. Don't reuse booking numbers for promotion.
- Recommended provider on cost/fit: **The SMS Works** — UK-domiciled (VAT-clean invoicing, no FX), ~3.1p + VAT per UK text, no monthly fee, credits don't expire (right for a bursty seasonal festival), undelivered texts refunded. A festival cycle of ~450 texts is roughly £14 + VAT.

### Testing

- **13 new integration tests (`tests/sms-send.test.mjs`), all passing against the test project and the real deployed functions.** They cover `send-sms` (401 unauthenticated; 400 for a missing recipient and for an unnormalisable number; a successful send that normalises `07700 900123` → `+447700900123`, logs to `sms_queue` and returns a `mock-` id; and a 200-character body billing as 2 parts) and `retry-queued-sms` (401/400/404; a retry stamping `retry_count`/`last_retry_at` and clearing the stale error; **409 on an already-`Sent` row**, the guarantee that a delivered text is never re-sent or re-billed; 409 on `Pending`; and the atomic claim under concurrency).
- The file carries a **safety interlock**: `before()` reads `sms_provider` from the test project and refuses to run unless it is `mock`, so the suite can never fire real, billable texts if someone points the test project at a live provider. Test recipients are Ofcom-reserved drama numbers (`07700 900xxx`), which are permanently unallocated.
- Note this **inverts** `email-retry.test.mjs`'s assumption: that file relies on Zoho being unconfigured so every send fails, whereas the mock provider always succeeds, so a send/retry is asserted to reach `Sent`.
- Not covered by automated tests: the browser wiring (tickbox → `sharedUpdateStatus` → `sendBookingSms`), which needs an authenticated admin session, and `queue-bulk-sms`, which has no UI trigger yet.

## [v7.13.0] - 2026-07-24

A focused pass over the Statistics page (`stats.html` / `js/stats.js`), triggered by a report that the page didn't show the refunded amount and expanding into a full review of the page. Shipped as five PRs (#103–#107), grouped here because they landed together in one continuous session. Minor bump: new visible information (refund and awaiting-payment figures, a Payment Requested status slice) plus fixes that change displayed numbers, not just internal cleanup.

### Added

- **The Statistics page now shows the refunded amount (#103, #104).** Refunds live only on the `payments` table, and `fetchStatsData()` fetched `bookings` alone — so refunded money was invisible on the one page meant to summarise festival finances. `fetchStatsData()` now embeds `payments(refund_amount)` through the `payments_booking_id_fkey` relationship (one-to-one: `booking_id` is payments' PK, so PostgREST embeds an object, not an array — the reader tolerates both shapes defensively). The Revenue Tracking card gains a **Refunded** row: an amber progress bar on the same Total Capacity scale as the Confirmed/Pending bars (so lengths compare honestly), plus an "N refunded bookings" caption, hidden until a refund actually exists — mirroring the Payments header's Refunded figure. Deliberately **not** netted out of the confirmed bar: a refunded cancellation already sits outside that forecast via its `Cancelled` status, so netting would double-count the deduction. Covered by two integration tests in `tests/refunds.test.mjs` — the exact embedded query shape as a genuinely authenticated admin (which also exercises the FK relationship being visible to PostgREST and RLS letting the embed through), plus the no-payments-row → null embed case.
- **"Awaiting Payment" revenue figure (#105).** A new blue Revenue Tracking row (bar + count, hidden when zero like Refunded) for `Payment Requested` bookings, whose money used to appear in no revenue figure at all — see the miscount fix below.
- **Refresh button (#106).** A page header ("Festival Statistics" + a refresh button, matching the Payments page's affordance) that re-runs `loadGlobalStats()` in place without a full page reload. `loadGlobalStats()` was already safely re-runnable — it destroys and rebuilds each chart — so this needed no data-layer change. Disabled with a spinning icon while a load is in flight so a double-click can't race two loads.

### Fixed

- **`Payment Requested` bookings were miscounted across the entire page (#105).** The database's `bookings_status_check` constraint allows six statuses; the page knew only five. `Payment Requested` fell through a catch-all into `Pending`, so it was lumped into the Status Overview doughnut's Pending slice, counted in **neither** revenue bar (a booking mid-Stripe-checkout — the money most likely to actually arrive — vanished from the forecast *and* from Total Capacity), and invisible in the per-instance panels' analyses while still inflating their Pending status box. It now has its own blue doughnut slice, the Awaiting Payment revenue row above, inclusion in Total Capacity, and its own **Awaiting Payment** box in each panel's status breakdown. This also fixed the doughnut's Pending count silently disagreeing with the revenue card's "N pending bookings" — they now use the same definition.
- **The "Need Power" count silently froze after v7.12.0's typo fix (#105).** `checkBool()` strict-matched only the old spelling `"Electricity supplied by fest organisors"`, but PR #89 (v7.12.0) corrected that typo to "organisers" in the booking forms. Stored bookings keep whichever spelling was current when they were submitted (production rows were never migrated), so every booking made *since* that fix was missing from the power counts — a frozen pre-fix undercount on the quick-stats card and both per-instance panel power metrics. Both spellings now match. The deliberate semantics — only festival-supplied electricity counts, not generator/gas self-supply — are unchanged and now documented in a comment so the next spelling change doesn't quietly break it again.
- **Cancelled and Rejected bookings inflated the operational charts and cards (#105).** The "Food vs General" pie used raw `foodData.length`/`nonFoodData.length` and the "Top Categories" bar tallied every row regardless of status, so a stall that cancelled in March still boosted its instance's slice and its category forever. The pie, the category chart, and the Need Power / Residents quick-stat cards now count active (non-Cancelled, non-Rejected) bookings only. The status doughnut and the per-instance status breakdowns deliberately still count every row — dead bookings are exactly what those exist to show.
- **Stray duplicated `</script></body></html>` block at the end of `stats.html` (#105).** Invalid markup (browser-ignored) that looked like a bad merge remnant; removed. An unreachable `else if (s === 'HCC Checks')` branch in the status-counting loop, made obvious while working nearby, was dropped at the same time.

### Changed

- **One money format everywhere on the page (#106).** All five Revenue Tracking figures now go through a single `fmtGBP()` helper and always render pence. `£425` sitting next to `£275.00` in the same card looked accidental, and partial refunds make whole-pound rounding lossy.
- **`renderPanel`'s status counters keyed by the literal status strings (#107).** They previously used respelled variants (`HCCChecks`, `PaymentRequested`) as object keys, each needing its own special-case match branch before the `hasOwnProperty` lookup — a future status containing a space would silently have needed a third. Keys are now the literal strings from `bookings_status_check`, matching `renderCharts`, and the branches are gone. No behaviour change.
- **CSP tightened to what the page actually loads (#106).** The `stats.html` policy allowed `challenges.cloudflare.com` (Turnstile), `unpkg` (Leaflet), `cdnjs` (Font Awesome), and Google Fonts — all copy-pasted from other pages and unused here (verified the shared nav is self-contained: inline SVG, no external fonts/CDNs). Scoped down to what the page really uses: jsdelivr (Chart.js + datalabels), Supabase, and the Vercel preview toolbar. Defence-in-depth, not a fix for an active issue.

### Accessibility

- `lang="en"` on `<html>` (was absent).
- The loading indicator is now `role="status"` with `aria-live="polite"`, and its spinner marked `aria-hidden`.
- All three chart canvases are `role="img"` with an `aria-label` that is **replaced with the actual data on every render** — "Bookings by status: Confirmed 13, Pending 94, …" rather than an unlabelled canvas a screen reader reads as nothing. (The collapsible per-instance panels were already keyboard-accessible.)

### Testing

- All five PRs passed CI (integration-tests, rls-grants-check, css-build-check, grep-guard) before merge.
- Browser-verified each change against the served dev page. The stats page can't be driven authenticated locally (it points at the production Supabase project, so signing in would mean entering the owner's admin password), so verification was: the whole `js/stats.js` module chain dynamic-imports cleanly after every JS change (catching syntax/link errors); the Revenue Tracking card, injected with representative figures, renders all four bars (green/yellow/blue/amber) at correct proportional widths (screenshot); a full page load under the tightened CSP produces zero "Refused to load" console violations; and the served HTML carries the expected `lang`, header, roles, and aria-labels. The refund data path itself is covered by the new integration tests plus #103's embed tests.

## [v7.12.0] - 2026-07-23

"UI Improvements 1" — a UI/UX review pass across the whole app (visitor map, every admin page, both public booking forms), followed by a functional QA pass exercising real flows end-to-end (Kanban, Location Manager, Payments/Refunds, HCC Checks, Steward App, Settings, User Management, and — once a Cloudflare test Turnstile key was configured on the test project — the previously-untestable public booking and cancellation forms themselves). Shipped as nine PRs (#87–#95), grouped here because they landed together in one continuous session. Minor bump: one real feature (marker clustering) plus several fixes that change visible behaviour, not just internal cleanup.

### Added

- **Visitor map marker clustering, empty state, and accessibility fixes (#87).** Dense pitch layouts now collapse into count-bubble clusters below zoom 18 (via `leaflet.markercluster`) and expand to individual pins at/above it — matching the zoom level search and "Locate Me" already jump to. Verified live: 4 tightly-packed fixtures cluster to a single "4" bubble at zoom 16, split into 4 pins at zoom 18. Also added: an empty-state message for when nothing is confirmed-and-located yet (distinct from a filter/search narrowing a populated map to zero, which already had its own toast); removal of `user-scalable=no` from the viewport meta tag, which blocked pinch-zoom for no functional gain; and `aria-label` on markers, since Leaflet's `DivIcon` (unlike plain `Icon`) never reads the `alt` option — confirmed by reading the loaded library source rather than assuming.

### Fixed

- **A failed confirmation/rejection email could mask a successful Kanban status change (#92).** `sharedUpdateStatus()` wrote the new booking status to the DB *first*, then sent a confirmation/rejection email as a side effect. If that email step failed (e.g. a missing `email_templates` row), the failure propagated into the outer error handler, which showed "Failed to update" even though the status write had already succeeded, skipped the success callback so the Kanban card never moved (or snapped back to its source column), and left the trader silently un-notified with no signal to the admin that anything needed retrying. Verified live by reproducing exactly this on the test project (which was missing the `confirmed_free`/`rejected` template rows): before the fix, both the Confirm-Free and Reject paths showed a misleading error with the UI out of sync with the DB; after, the card moves correctly and the toast accurately reports the partial failure ("Booking confirmed, but the email failed to send: …").

- **Confirmation modal backdrops rendered fully opaque instead of a translucent dim (#93).** `bg-{color} bg-opacity-{n}` is dead syntax under Tailwind v4 (this project's version) — the opacity half silently no-ops. Affected the shared `showConfirm()` helper used app-wide for confirmations, plus dedicated modals on Email Templates, Payments (×3), and the Steward app. Switched all six spots to the v4 slash syntax (`bg-black/50`, etc.); verified live on two of them.

- **Payments Dashboard "Updated By" showed the original payer, not who processed the refund (#93).** The column always read the payment row's `editor` field, never `refunded_by`, so after a real admin recorded a refund the UI kept crediting whoever entered the original payment. Verified via direct DB query that `refunded_by` was recorded correctly while the UI showed the stale value; now prefers `refunded_by` once a refund exists.

- **Public forms showed a generic, useless error on server rejection instead of the real reason (#95).** Food Stall submission, General Booking submission, and Cancel Booking all threw `"Server error: " + error.message`, but `supabase-js`'s `functions.invoke()` wrapper always sets that to the generic "Edge Function returned a non-2xx status code" — never the actual reason from the response body. Now uses the existing `parseEdgeFunctionError` helper to read it. Also fixed Cancel Booking's error handler double-processing that now-real message through `safeError()`, whose `"token"` substring match was misfiring on the legitimate phrase "cancel token" and replacing a correct, specific message with a confusing "Authentication error. Please refresh the page." Verified live end-to-end (see Testing, below): an invalid cancel token now correctly shows "Invalid or expired cancel token."

- **Dead links across five public/admin pages.** `PORTAL_URL` (`ellastreet.co.uk/fest26/portal`) 404s — the site has no `/portal` path; corrected to the real page (`/fest26`) in both the code default and the stale value already saved in production's settings table (#90, #91). "Contact us" on the two payment-result pages and Cancel Booking's invalid-link state pointed at that same dead URL — repointed to the site's real `/contact` page (#90). "Privacy Policy" on both booking forms was linked to a page that doesn't exist anywhere on the real site — reverted to plain text rather than a mislabelled link (#90).

- **Payments Dashboard COST column showed raw numbers, not currency (#88).** `80`/`60` instead of `£80.00`/`£60.00`, inconsistent with every other money value on the same page.

- **Booking Editor sidebar truncated every status to 3 characters (#88).** `item.status.substring(0, 3)` rendered "Confirmed" as "Con". Shows the full status now, with the business name truncating instead.

- **Typos on the Food Stall form and its admin-side counterpart (#89).** "Deserts" → "Desserts", "organisors" → "organisers", "suppied" → "supplied" (×2), "Hygene" → "Hygiene". The power-requirement option values had to be fixed in both the public form and the Booking Editor together, since a booking's stored value has to match one of the editor's `<option>` values to show as selected.

### Accessibility

- Email Template Manager's template list items were plain clickable `<div>`s — unreachable by keyboard, invisible to screen readers as interactive. Added `role="button"`, `tabindex="0"`, and Enter/Space activation; verified live that Enter on a focused item opens its editor (#88).
- The nav's mobile hamburger button had no accessible name; added `aria-label`, `aria-expanded`, `aria-controls`, kept in sync on toggle (#88).
- The nav's DEV/FOOD/GENERAL/MISC instance-selector dropdowns used `focus:outline-none` with no replacement focus style, so tabbing to them showed no visible indicator at all — not a Tailwind v4 regression, just a pre-existing gap noticed while auditing `outline-none` for other v4 migration casualties. Added the same `focus:ring-2` pattern used everywhere else in the app (#94).
- Food Stall and General Booking forms: the Category, Resident?, and Declarations checkbox/radio groups now use `<fieldset>`/`<legend>` instead of a plain label followed by inputs, so a screen reader announces the group a checkbox belongs to (#89).

### Testing

- Configured Cloudflare's official always-passes test Turnstile site key on the test project (server-side secret was already set, for the existing integration tests' dummy-token flow) — unlocking real, full end-to-end browser testing of both public booking forms and the cancel-booking flow for the first time. Verified live: a complete Food Stall submission with file upload, a General Booking submission, a real cancellation, and the invalid-token error path all worked correctly through the actual UI, no code changes required for any of them.
- A full functional pass followed: Kanban drag-and-drop (including the confirm/reject bug above), Location Manager pitch assignment, the Stripe test-mode chargeable-confirmation flow (real `cs_test_…` checkout session created), Resend Payment Link, Record Bank Transfer, HCC Checks (including its bulk-email path, which was already structured safely — template fetch happens before any write, so a missing-template failure there never corrupts state the way the Kanban bug did), the Steward app's location assign/unassign, Booking Editor saves, Settings page saves, Add Misc Entry, and Email Queue retry — all verified against real writes to the test project's database, all working correctly with no further bugs found.

## [v7.11.0] - 2026-07-22

A batch of settings-security hardening plus a documentation rewrite, from a review of the `settings.html` Stripe card and the two public Edge Functions. Shipped as four separate PRs (#72–#75), grouped here because they landed together. Minor bump rather than patch: the Stripe settings UI now behaves visibly differently (stored credentials are never shown), and two new shared modules were added.

### Security

- **The Stripe credential fields on Settings are now write-only.** `settings.html` used to read the stored secret keys straight into the DOM on every load. `type="password"` masked them visually, but they were readable from devtools, from any XSS on that page, and by browser extensions — so one compromised admin session was a live-key exfiltration, not just an account takeover. The page now learns only *whether* each credential is set, never its value: the status query selects the `key` column alone and pushes the "is it set" test server-side as a `.neq('value', '')` filter, so the secret never crosses the wire. Verified against the test project with a canary — the query returns `[{"key":…}]` with no `value` field and no trace of the secret, where the old `select('key, value')` returned it in full. Typed values are also cleared from the inputs once saved. (PR #73)

  **What this does and doesn't buy:** admins retain `SELECT` on the `settings` table via RLS, so a determined admin can still read the values through the API. This closes the *incidental* exposure (DOM, devtools, extensions, shoulder-surfing), not the deliberate one — which would mean moving the secrets out of the settings table entirely and giving up the admin-editable rotation that `_shared/stripe.ts` documents as the reason they live there. Today's risk was latent regardless: HANDOVER records `stripe_secret_key_live` as unset, so no live key was actually on screen — the point was to change the pattern before one ever lands there.

- **The two public Edge Functions no longer leak internals in error messages.** `submit-booking` and `cancel-booking` both ended in `catch (error) { return { error: error.message } }` with a 500, which returned raw Postgres text (table, column, constraint names), RPC failures, and server-config state — `TURNSTILE_SECRET_KEY is not configured on the server.` was reachable by anyone who could POST — straight to an anonymous caller. A new `_shared/errors.ts` introduces `PublicError`: only messages explicitly marked as such are echoed; everything else is logged in full server-side and replaced with a generic message carrying a short reference id that appears in that log line, so failures stay supportable without detail in the response. Validation failures now also return **400** rather than the old blanket 500. (PR #75, requires the deploy noted below)

  **Allow-list, not deny-list — deliberately unlike `js/utils.js`'s `safeError()`.** That one pattern-matches known-dangerous messages and passes anything else through, which is the right trade for admin-facing UI where the caller is trusted, but it fails *open*. At a public boundary a throw site added later must be safe by default, so here it stays generic unless someone opts it into `PublicError`. Scope is the two public functions only — the admin-authenticated ones keep their detailed errors, which are what make a failure diagnosable and which four suites in `tests/` assert on. The Cloudflare CAPTCHA rejection path also keeps returning Cloudflare's own error codes on purpose, since `page-food-booking.js` surfaces them and Turnstile is fiddly enough to configure that losing them would cost more than the mild disclosure.

### Fixed

- **Saving the Stripe settings could silently wipe the stored credentials.** The save handler wrote all four rows unconditionally from the input values, and an empty input is indistinguishable from "no value configured" — so any save performed while a field was blank overwrote whatever was stored with an empty string. Two ways it fired: (1) the initial credentials load failed (transient network, expired session), the `catch` showed a toast and carried on with the inputs empty, and the next save wiped all four rows; (2) the *documented, intended* workflow — "save the Test pair now, add Live later" — wiped the Live keys every time, because they were blank. The code contradicted its own comment. A blank field now means "leave this row alone" (the rule lives in the new import-free `js/stripe-credentials.js`, pinned by `tests/stripe-credentials-save.test.mjs`), and a failed load disables the save button outright. (PR #72)

  **Tradeoff:** a credential can no longer be *cleared* from this UI, only replaced — clearing one is a rare deliberate act with a direct route (edit the `settings` row), whereas wiping one by accident was a single click away. The write-only change above later made "blank on load" the *normal* state, which is what makes this rule load-bearing for more than the original bug.

### Documentation

- **`ARCHITECTURE.md` rewritten to match the code.** It was stamped "v3.0 / February 2026" against a v7.10.5 codebase and had drifted far enough to actively mislead — the risk being a new contributor trusting it and editing the wrong file (it named `js/config.js` the source of truth for Supabase credentials; it is `supabase-public.js`, and repointing it has caused a real outage). Every claim was verified against source. Corrected, among others: a documented `GAS/` folder that doesn't exist (replaced by `api/ping.js`), a dropped `bookings.location_id` column (now the `booking_locations` join table), a removed `On Hold` status, the wrong production URL, and a `VALID_STATUSES` array in `utils.js` that doesn't exist (`validateStatus()` reads `CONFIG.UI.STATUS_LIST`). Added, having been absent entirely: Stripe payments and refunds, the settings table, all ten Edge Functions with their real auth model, testing/CI, the offline steward app, and an explicit note that `performers`/`schedules` belong to a separate external app this repo only RLS-scopes. Reframed the header to give the docs a clear division of labour — this file for the shape of the system, HANDOVER.md as the authority for behavioural detail. (PR #74)

### Deployment

- **`submit-booking` and `cancel-booking` redeployed to BOTH projects.** The error-sanitisation change (PR #75) is Edge Function code, which CI does not deploy. Both functions were deployed to the test project (`qeplpcnrkgpaawfyliap`) to run the suite, then to production (`rsnxhuhibglieofikkpo`) — same bundles, verified 8/8 on the new suite and 167/167 on the full integration run against test before the production deploy. The three settings/docs PRs (#72–#74) are static assets served by Vercel and needed no manual deploy.

### Note

- **The invalid-filename test can't use `../../etc/passwd`.** Writing `tests/public-error-sanitisation.test.mjs`, the obvious bad-filename fixture returned a **403 with a non-JSON body** — Supabase's edge WAF blocks that path-traversal string in the request body *before* it reaches the function, so it never exercises our own validation. The fixture is `bad name;rm.pdf` instead (fails `SAFE_FILENAME_PATTERN`, not attack-shaped), documented in the test so nobody restores the traversal string and gets a mystery 403.
- **Pre-existing, not changed here:** `submit-booking` validates uploaded filenames at step 5, *after* the booking row is inserted at step 4 — so a bad filename returns an error with the booking already committed. It's why the new suite has a cleanup step.

## [v7.10.5] - 2026-07-21

### Fixed

- **`charge.refunded` recorded the Stripe *charge* id where a *refund* id belongs.** `refund_reference`'s schema comment documents it as holding a Stripe refund id (`re_…`); every dashboard-issued refund was writing a charge id (`ch_…`) instead. The cause was `charge.refunds?.data?.[0]?.id || charge.id`, which reads as a defensive fallback but wasn't one: **`charge.refunds` is absent from the `charge.refunded` payload on current Stripe API versions** — verified live against `2026-06-24.dahlia`, which carries neither `refunds` nor `latest_refund` — so the `|| charge.id` branch was the *only* one that ever ran. The refund id now comes from an API lookup, using a client built for whichever mode's secret actually verified the signature (previously not captured at all, and necessary because querying live Stripe about a test-mode object just 404s). The embedded list is still checked first so an API version that does include it costs no extra round trip, and `charge.id` remains the last resort — recording a refund against a weaker reference beats failing the webhook and leaving the refund unrecorded, which is the hole this handler exists to close.

  Blast radius was small (a charge id is still traceable in Stripe, and the schema only supports one refund per booking), but it silently violated its own documented contract while reading as though the good path normally won.

### Note

**This is what the end-to-end refund test found.** HANDOVER had flagged, across four releases, that no refund had ever been watched end to end against a real Stripe charge. Running it — a real test-mode charge, refunded in Stripe exactly as a dashboard refund would be — reconciled correctly in every respect *except* this field, on both a partial (£30 of £80) and a full refund. Everything else the last four releases built held up against data the webhook wrote rather than data constructed for the test: the badge flipped to REFUNDED, `paid` stayed `true`, the dashboard header read Paid £100.00 / Refunded £30.00, and the CSV's Net Paid column summed to the header total.

The remaining untested link is `refund-payment` itself (the admin-initiated path), which by deliberate design requires a human: *"Admin JWT only, with no service-role bypass: issuing a refund moves real money and must always be a deliberate human action."*

## [v7.10.4] - 2026-07-21

### Fixed

- **The Stats page computed Revenue from hardcoded £50 food / £25 non-food**, ignoring the stall costs configured in Settings entirely. Changing a price there left this page reporting the old one indefinitely, with nothing on screen to suggest its figures had stopped matching what traders were actually being charged. It now prefers the booking's own `stall_cost` — the amount genuinely agreed, and the same field the Payments dashboard bills and reconciles against, so the two pages can't disagree about a booking they both know the price of — falling back to the configured price for the instance when a booking hasn't been priced yet. `stall_cost` is only set when payment is requested, so Pending bookings legitimately have none and the configured price is the right estimate for them. That split also means a price change in Settings moves the *potential* revenue figure without retroactively rewriting what already-priced bookings were agreed at, which is the behaviour you want from a forecast.

  **Impact is narrower than it sounds:** production is configured at exactly 50/25 today, so switching to the settings changes no displayed number — the divergence removed is *latent*, and would have surfaced silently the first time someone edited a price. The figures **do** change for any booking whose agreed `stall_cost` differs from list price, which is the case the old code got wrong. Whether production has such bookings could not be established without an admin session; anon is correctly refused by RLS on `bookings`.

  Also incidentally removed: a missing DEV branch that made DEV bookings worth £0. It was dead code — `calculateRevenue` is only ever called with the combined FOOD + NONFOOD set.

### Note

`getStallCost()` returns 0 and warns when the settings haven't loaded, so calling it before `loadStallCosts` had run would have made Revenue silently display **£0** — worse than the bug being fixed, and not the sort of thing that shows up in review. The ordering was verified by reading the call chain: `initAdminPage` awaits `requireAuth`, which awaits `loadStallCosts`, before the page callback runs.

## [v7.10.3] - 2026-07-21

### Fixed

- **The CSV export had no refund awareness.** A fully refunded booking exported as `Paid: Yes` at its full cost, with nothing recording that the money had gone back. This mattered more than the equivalent on-screen bug fixed in v7.10.2, because the export is the artefact that gets reconciled against the bank — a wrong number that leaves the building. Adds **Refund Amount**, **Refunded On** and **Net Paid** columns. `Paid` deliberately stays Yes/No as a truthful record that a payment was once taken; **Net Paid** is the column that sums to cash actually held, and it agrees with the dashboard's Paid total by construction.

- **The CSV export ignored three of the six payment filters.** Its filtering logic was a *duplicate* of the table's that had drifted apart, knowing only `paid` and `unpaid`. Selecting **Awaiting Payment**, **⚠ Needs Refund Follow-Up** or **Refunded** and clicking Export reported *"No data to export"* while the table on screen was visibly full of matching rows. The same copy had also lost the `!awaitingPayment` clause from its `unpaid` branch, so exporting Unpaid silently included mid-Stripe-flow bookings that the table excluded. Both are one failure — an export that doesn't match what the admin is looking at — so the predicate is now shared between the two rather than duplicated, duplication being what allowed the drift.

- **Unticking "Paid" on a refunded booking showed a raw Postgres constraint error.** The database refuses it via `payments_refund_requires_payment`, which is correct and caused no data corruption (verified against the test project), but the admin saw `new row for relation "payments" violates check constraint ...` in a toast — text that reads like a fault rather than a rule. Now caught in the UI for **wording only**; the constraint remains the actual guarantee, deliberately, since a client-side check that resembles enforcement invites misplaced trust.

### Note

These came from a deliberate sweep of every consumer of `paid` after v7.10.2, prompted by that release being the second bug in a row from the same root: `paid` stays `true` after a refund by design, so **every reader must subtract `refund_amount` itself**. Also checked and found correct: the desktop and mobile badges, the refund button's `paid && !refunded` gating, `refund-payment`'s `paid !== true` guard, and `stripe-webhook` (which reads Stripe's own unrelated `payment_status`). Separately noted but not changed: `js/stats.js` reports Revenue from hardcoded £50/£25 and never loads payments at all, so it ignores the configurable stall-cost settings — unrelated to refunds, but it means changing prices in Settings leaves that dashboard reporting the old ones.

## [v7.10.2] - 2026-07-21

### Fixed

- **The Payments dashboard's Paid total ignored refunds.** It summed the full `stall_cost` of every row with `paid = true`, and since v7.10.0 `paid` deliberately *stays* true after a refund — the payment really did happen, and the refund is separate state layered on top of it. Nothing subtracted it back out, so a refunded booking went on inflating the headline figure forever and the dashboard reported money the festival no longer holds. The per-row display had always handled refunds correctly (the badge flips to `REFUNDED`, with the amount and date shown), which made the gap easy to miss and worse when hit: the row said REFUNDED while the total directly above it still counted the cash. Paid is now net of refunds, and a **Refunded** tile accounts for the difference — netting money out of Paid with nothing explaining where it went would only replace a wrong number with an unexplained one. The tile is hidden when the total is zero, which is the normal case. Refunded rows keep `paid = true` and so stay out of Pending, which is correct: a refunded cancellation is not money owed. `rpc_record_refund` caps a refund at the booking cost, so no row can contribute a negative amount.

  This is the second bug in a row traceable to v7.10.0 changing what payment state *means* without updating everything that reads it. The design decision is sound, but its consequence is a standing obligation: **every consumer of `paid` must subtract `refund_amount` itself**, because `paid = true` no longer implies the money is held.

## [v7.10.1] - 2026-07-21

### Fixed

- **The refund button added in v7.10.0 was invisible in production.** It was present, clickable and correctly wired, but rendered as white text on a transparent background — the amber colours it used had never been used anywhere else in the project, and `css/output.css` is a *committed build artefact* (there is no build step at deploy time; the file is served as-is). Tailwind only compiles classes it finds when scanning the source, so without a rebuild the markup referenced CSS rules that did not exist. Rebuilding is purely additive; it also restored `disabled:cursor-not-allowed`, which had been missing since the Email Queue Retry button in v7.1.0 and gone unnoticed.

### CI

- **New `css-build-check` job** rebuilds Tailwind and fails if the committed `css/output.css` is stale. `git status` cannot catch this class of bug, because the stale file *is* committed and the working tree is therefore clean — and the failure is silent at runtime, since a class with no rule renders as nothing at all rather than erroring. Verified to fail on a genuinely stale file and pass on a fresh one.

### Documentation

- **Added a Stripe go-live checklist**, recording that production currently takes **no real card payments** (`stripe_test_mode` is `'true'` and the live credentials are unset — a coherent state, not a broken one, but not previously written down). Covers the three steps needed to go live and why their order matters: flipping the toggle before setting the live key makes payment collection throw by design. Also notes the Live-mode webhook endpoint must enable the same events as the Test-mode one, `charge.refunded` included, or dashboard-issued refunds silently stop reconciling.

## [v7.10.0] - 2026-07-21

**New feature — database changes and two Edge Function deploys, already applied to production.**

### Added

- **Refunds.** Previously there was no refund support of any kind: no UI, no API call, and no columns to record one — a trader who cancelled after paying meant a manual Stripe-dashboard refund with nothing recorded in the app. Now:
  - **Record a refund** against any paid booking from the Payments page, for either payment method. Supports **partial refunds** (e.g. a late cancellation refunded at 50%). The actor is derived server-side from the admin's session rather than trusted from the browser, and an external reference (Stripe refund ID or bank reference) is required.
  - **Issue Stripe refunds directly** from the app via a new `refund-payment` Edge Function, behind an explicit confirmation naming the amount, since it moves real money irreversibly. Bank transfers stay record-only — there is no API that moves that money back, so the asymmetry is inherent to the payment methods.
  - **Refunds issued in the Stripe dashboard now reconcile automatically** via a new `charge.refunded` webhook handler, closing the "refunded externally, app never finds out" gap that a record-only flow can't cover on its own.
- **A booking cancelled after payment is now flagged for follow-up.** `cancel_booking_secure()` allows cancelling a `Confirmed` booking and never touched `payments`, so a paid booking could be cancelled with its payment row still reading `paid = true` and no refund trail — a live gap independent of refunds. Self-service cancellation deliberately still succeeds (blocking it would strand the trader with no way to cancel), but the Payments page now shows a **⚠ CANCELLED — REFUND?** flag, plus filters for it and for refunded bookings. Derived from existing state rather than stored, so there is no flag to set, forget to clear, or let drift.

## [v7.9.0] - 2026-07-21

**Database change, already applied to production.**

### Security

- **Scoped anon's `schedules` access to Scheduled/Paid performers only, matching what `public_schedule_info` has always filtered to.** The base table's own anon policy was `USING (true)` — the view's status filter was never enforced at the table level, so a caller reading `schedules` directly (bypassing the view) could see slot times and performer IDs for Applied/Rejected performers too. Column grants already stopped resolving those IDs to a name, but the slot data itself was still exposed. Verified safe to apply with no external coordination: `schedules` held zero rows in production both when this was found and again immediately before applying, so nothing any consumer — including the separate performer app this repo can't audit — was already reading changed. Implemented with a new `SECURITY DEFINER` helper, `is_performer_publicly_visible()`, mirroring the existing `is_booking_confirmed()` pattern; a first attempt using a plain subquery hit a real permission error (anon's column grants on `performers` don't cover the field the filter needs), caught on the test project before it reached production.

## [v7.8.0] - 2026-07-20

**Database change, already applied to production**, plus a CI tooling fix.

### Changed

- **Consolidated `get_is_admin()` into `check_user_role('admin'::user_role)`, dropping the now-redundant function.** The two were behaviourally identical — same `SECURITY DEFINER` body, same `auth.uid()` lookup against `user_roles`, one hardcoded `'admin'`, the other parameterized. `get_is_admin()`'s only call site anywhere was the policy governing `user_roles` itself; confirmed before touching anything by grepping every function body in a live production dump for an embedded call, not just relying on dependency tracking (which wouldn't show this either way). A follow-up to the `user_roles.role` enum consolidation (v7.6.0) that finishes what it started — one canonical admin-check mechanism instead of two.

### Fixed

- **`check-rls-grants-snapshot.sh` no longer misses changes buried in a policy's continuation lines.** It previously captured only each `CREATE POLICY`/`GRANT`/`REVOKE` statement's first line, so a change to a policy's actual `WHERE` expression (almost always on a later line, since `pg_dump` wraps these) could show as unchanged. It now accumulates a statement across lines until the one that actually terminates it. Regenerating the snapshot with the fix surfaced one unrelated bonus catch — a `storage.objects` policy was also silently truncated the same way — confirmed unchanged in substance, just newly visible in full.

## [v7.7.0] - 2026-07-20

**Frontend-only — no schema or Edge Function change.**

### Added

- **Bounded every admin list query that previously had no `.limit()`/`.range()` at all.** Fine at ~184 bookings today; insurance against a slow-motion failure as data grows, consistent with the audit-log and email-queue pages, which already paginate. All four unbounded queries — the Kanban board, the Payments dashboard, Location Manager (including its occupancy check), and the Statistics page — now use a generous cap (1000 for board/table views, 5000 for stats, since a truncated aggregate produces a wrong-but-plausible number rather than a visibly incomplete list) with a one-time "showing first N" notice if the cap is ever actually hit. Payments deliberately got this cap-and-notice treatment rather than real pagination, since its running Paid/Outstanding totals are computed client-side over the whole filtered set — true pagination would make those totals silently reflect only the current page. No behaviour change at current data volumes, verified live against every affected page.

## [v7.6.0] - 2026-07-20

**Database change, already applied to production.**

### Changed

- **Consolidated `user_roles.role` onto the pre-existing `user_role` enum, dropping the `eq_text_user_role()` operator shim.** The shim existed only to make an internal cross-type comparison (`text` = `user_role`) resolve for one function — invoked by Postgres's operator resolution with no textual call site anywhere, so grepping for its name could never prove it unused. With `role` now genuinely `user_role`, the comparison is native and the shim is gone. Scope was established by tracing every reference to the column in a live production dump rather than assuming one function was the only consumer: 13 of the schema's 23 policies touch it, split across three categories that needed entirely different handling — 7 needed no change at all, 1 was unaffected either way, and 6 had the comparison inlined in the *opposite* cast direction from the shim and would have broken silently if missed. No client-facing change: role values still round-trip as plain strings (`"admin"`/`"steward"`), verified directly. An invalid role is now rejected by the type itself rather than a CHECK constraint.

## [v7.5.0] - 2026-07-20

**Database change, already applied to production.**

### Removed

- **Dropped the orphaned `location_power` table.** Flagged by a review for having no primary key and no foreign key to `locations`. It was *not* empty — it held five rows of deliberately written data (power-availability notes for `Music Stage`, `On the street`, `Beach`, `After party`, `Green`), and its own `COMMENT` described it as "power availability at each performance location," identifying it as belonging to the performers feature rather than stall pitches. That feature is served by a separate app (`ellafestperformersadmin.vercel.app`) this repo can't audit, so the drop was confirmed with the project owner before acting rather than inferred from "no references in this repo" — which, on its own, would have been the wrong evidence for this specific table. Made reversible before dropping anything: `supabase/sql-archive/restore_location_power.sql` recreates the table, its two policies, three grants, and all five rows exactly as captured from production immediately before the change.

## [v7.4.1] - 2026-07-20

**CI configuration only — no application, schema, or Edge Function changes.** The live site and database are unchanged; the last release affecting them is v7.4.0.

### CI

- **PR merges no longer block on a check that never ran.** An unscoped `push:` trigger fired a second, duplicate run for every branch that also had a PR open. GitHub keeps only one *pending* run per concurrency group and evicts the previously-pending one when a newer run queues behind the in-progress one — so with two events firing, the `integration-tests` job could be cancelled before executing, while still reporting a non-success required check against the head commit. Branch protection then blocked the merge for a run that never happened (hit live on PR #43; earlier PRs escaped only because both runs happened to finish before a third queued). Fixed by scoping `push` to `main`, giving exactly one run per PR plus one on merge — which also halves contention on the serialised shared test database. Note the fix is deliberately **not** in the concurrency block: `cancel-in-progress` was already `false` and must stay so, since cancelling a run mid-suite would abandon fixtures in the shared database for the next run to trip over. Tradeoff: pushing a branch with no PR open now runs no CI, matching this repo's PR-based convention.

## [v7.4.0] - 2026-07-20

**Database changes, already applied to production.** Four findings from a schema/permissions review, each verified against the live schema before acting rather than taken on trust.

### Security

- **Stewards can no longer UPDATE `bookings` directly.** The `"Steward update"` policy allowed UPDATE for any steward with no `WITH CHECK`, and `authenticated` holds full-column UPDATE on the table — so a steward session could write `stall_cost`, `status`, `cancel_token`, the Stripe columns, anything. Only reachable by a compromised or malicious steward account, but it was the widest remaining privilege gap in the schema. **Dropped rather than narrowed**: tracing the actual usage showed nothing used it — `steward.html` never updates bookings, it reads (still permitted by the separate `"Steward access"` policy) and assigns pitches through `rpc_set_booking_locations()`, a `SECURITY DEFINER` RPC that does its own role check. Admin writes are unaffected.
- **`audit_logs.user_email` is now stamped server-side from the request JWT.** The insert policy is `WITH CHECK (true)` and the value was ordinary client-supplied text, so any authenticated staff account could write audit entries attributed to someone else — an audit trail its own subjects can forge. A `BEFORE INSERT` trigger now overwrites it, mirroring how `verified_by` is already server-derived for bank transfers. It only overwrites when an email claim exists (Edge Functions insert as `service_role`, which has none, and blanking or rejecting those would break server-side logging) and swallows malformed claims rather than raising, since a trigger that blocks a write from being recorded would be worse than the spoofing it prevents.
- **Revoked the vestigial `anon` EXECUTE grant on `rpc_set_booking_locations()`**, finishing the sweep that the v5.1.3 migration started for `cancel_booking_secure()` and `get_next_booking_id()`. Not a live hole — the function already rejected anon internally — but the grant described access no caller has ever needed.

### Changed

- **`bookings.status` is now constrained** to the six real statuses (`Pending`, `Payment Requested`, `Confirmed`, `Rejected`, `Cancelled`, `HCC Checks`). It was unconstrained `text`, with the status machine enforced only in app code and RPC guards, so a typo from future code or a direct SQL fix would strand a booking invisibly — every board filters by status, and a row with an unrecognised one renders in no column at all. Implemented as a **CHECK constraint, deliberately not an enum** despite `is_charity` having been converted to one: Postgres cannot remove a value from an enum type, and this project has added and then removed `Pre-Confirmed`, `Paid` and `On Hold`, each of which would have required a full type swap. Verified against live data first — all 184 production bookings already held valid values.

### Testing

- New `tests/privilege-hardening.test.mjs` — 12 behavioural tests covering all four changes against the real REST API as genuinely authenticated sessions, including regression guards that admins can still update bookings and still assign pitches.

## [v7.3.1] - 2026-07-20

**Documentation only — no code, schema, or configuration changes.** The live site is unchanged; the last release affecting it is v7.2.0.

### Documentation

- **Brought HANDOVER's reference sections back in line with reality.** Its chronological "Next Steps" log had been kept current as each change landed, but the reference half (architecture, data model, current state, testing) had drifted — so the document *looked* maintained while sections 3–6 quietly went stale, which is the more dangerous failure for a file written to be trusted by someone with no prior context. Fixed: the Edge Functions table was missing `retry-queued-email` entirely and still described `get-reviews` as uncached; `google_reviews_cache` was absent from the data model and `email_queue` was missing its `retry_count`/`last_retry_at` columns; "Known gaps" still claimed there was no Email Queue browse/retry UI (browse shipped in v5.1.0, retry in v7.1.0) and pointed at the wrong source file; the testing section said "three test files" when there are eight and 108 tests; and the repository layout listed neither `scripts/` nor `tests/`. Every claim was re-checked against the repo rather than the prose.

## [v7.3.0] - 2026-07-20

**Developer tooling only — no production surface.** Nothing about the deployed site, database, or Edge Functions changes in this release.

### Added

- **`npm run dev` now proxies Supabase traffic same-origin, so Edge-Function-backed features can finally be verified in a local browser.** Previously any Edge Function call from a localhost page failed with `Failed to send a request to the Edge Function`: `_shared/cors.ts` pins `Access-Control-Allow-Origin` to the production origin, so the browser rejected the response. That left Retry, bulk email and checkout-session unverifiable locally, which is why several recent fixes shipped needing an admin to confirm the button by hand. The dev server now proxies `/__supabase/*` to the test project and the local override points the Supabase client at that path, making auth, PostgREST, Edge Functions and storage all same-origin — so CORS never applies. Deliberately chosen over per-request origin negotiation in `_shared/cors.ts`, which would have touched all eight functions including the payment paths and silently destroyed `tests/cors.test.mjs`'s coverage of the production CORS posture; this approach changes no Edge Function and no test. Verified by clicking the Email Queue Retry button end-to-end in a real browser (`retry_count` incremented, `last_retry_at` stamped, fresh Zoho error, `audit_logs` entry written).

### Changed

- `esfUseTestProject()` now takes only the anon key plus an optional banner label, **not a project URL** — the dev server picks the target from `TEST_SUPABASE_URL`, so a page cannot aim itself at an arbitrary Supabase project, let alone production.

## [v7.2.0] - 2026-07-20

### Fixed

- **Payment Tracker modals rendered underneath their own overlay.** Pressing "Record Bank Transfer" blanked the screen and recorded nothing — the modal was in fact opening and fully populated, but was being painted *under* the grey overlay, so there was no way to reach the Save button. Both symptoms had one cause: the form could never be submitted, so nothing was written. The overlay is `fixed` (positioned) while the panel was `static`, and a positioned element paints above a static one regardless of DOM order; the markup only ever worked because Tailwind v3's bare `transform` utility created a stacking context on the panel, and under v4 that computes to `transform: none`. Fixed with `relative z-50` on the panel, matching the pattern every other modal in the app already uses. **The "Edit Payment" modal on the same page was broken identically** and is fixed by the same change — it had simply never been reported.

### Added

- **Local test-project override, so browser flows can be verified against the disposable test project instead of production.** `supabase-public.js` points at production, which meant loading any admin page locally talked to the live database and clicking a button could email real traders. It now reads an override from `localStorage`, applied *only* on an exact-match localhost origin — a deployed origin cannot reach that branch, so production behaviour is unchanged, and nothing lives in a file that could be committed by accident (this file caused a full outage on 2026-07-18 when it was repointed and committed). When active it announces itself with a console warning and an on-page banner naming the project. Helpers: `esfUseTestProject(url, key)` / `esfUseProduction()`.
- **`npm run dev`** — a loopback-only dev server that additionally widens each page's CSP `connect-src` *in the bytes it serves, never on disk*, since every page pins its Supabase project in a CSP meta tag that would otherwise block the test project. The deployed CSP stays exactly as strict.

### Documentation

- **HANDOVER now carries a tiered agent-autonomy policy** replacing the previous blanket "no agent should run `supabase db push`" rule, which was overridden ad-hoc often enough that it caused round-trips for safe work while giving no guidance on genuinely risky actions. Green (act freely: additive migrations, function deploys, merging green PRs, cutting releases), amber (act, but a stated verification is mandatory), red (needs an explicit instruction naming the action: sending real email, moving real money, destructive DDL, repointing `supabase-public.js`, rotating credentials, rewriting history).

### Chore

- Root-level ad-hoc schema dumps (`schema*.sql`) are now gitignored, rather than only the single literal `schema.sql`.

## [v7.1.0] - 2026-07-19

### Added

- **Retry failed emails from the Email Queue viewer.** `email_queue.html` has shown failed sends with their exact Zoho error since v5.1.0, but an admin looking at one had no way to act on it — the only recovery was re-triggering the original action from the booking, which isn't even possible for every email type (the "received" auto-responder, for instance). Failed rows now have a Retry button, backed by a new `retry-queued-email` Edge Function (admin-JWT only, no service-role bypass — retrying is a human recovery action). It runs server-side because `authenticated` deliberately has no UPDATE on `email_queue` and the Zoho credentials are server-side. The function claims the row (`Error → Processing`) before sending, so two retries in flight can't both deliver, and an already-`Sent` row can never be re-sent; a row that fails again returns to `Error` and stays retryable, which is the point. New `retry_count`/`last_retry_at` columns surface repeat failures in the viewer, since a row that has failed five times usually means a bad address or a Zoho config problem rather than something another retry will fix. Retries are audit-logged as `retry_queued_email`.

## [v7.0.0] - 2026-07-19

Version number set by the project owner. Note this jumps from the 5.1.x line
directly to 7.0.0 — there is no 6.x series, and this release contains a bug fix
rather than breaking changes, so the major bump reflects a deliberate
versioning decision rather than a semver-driven API break. Nothing about the
database schema, Edge Function contracts, or admin workflows changes here.

### Fixed

- Password-reset links now actually let an admin set a new password. The recovery page stripped the `#access_token=…&type=recovery` fragment from the address bar *before* the Supabase client was constructed — and the client reads that fragment at construction time to establish the session — so no session ever existed and "Update Password" always failed with `AuthSessionMissingError: Auth session missing!`. The client is now created first, then the URL is scrubbed. Confirmed working end-to-end against a real reset link. (This is the third and final fault in the password-reset chain, after the v5.1.2 client-side redirect fix and the v5.1.4 hosted Site URL/allowlist fix — both of those were necessary but neither made the flow work, because this bug sat behind them.)

## [v5.1.13] - 2026-07-19

### Added

- Server-side caching for the booking detail pane's Google Maps ratings/reviews lookup, cutting SerpApi usage: the pane auto-searches on every open of a food-stall booking (two metered SerpApi calls each time), and identical lookups now serve from a new `google_reviews_cache` table (service-role only) for 7 days — overridable via a `reviews_cache_ttl_hours` settings row — instead of re-hitting SerpApi. Not-found results are cached too; only the explicit "Refresh Google Maps" button bypasses the cache; cached results are labelled with their fetch time; and cache failures degrade to the old fetch-every-time behavior rather than ever breaking lookups (which also made deploying the function ahead of the migration safe). Five new integration tests prove the hit/bypass/TTL/lockout behavior without making a single real SerpApi call; verified on the disposable test project (99-test suite green), then applied live with the RLS/grants snapshot showing exactly the one expected new grant.

## [v5.1.12] - 2026-07-18

### Fixed

- The settings.html "Closed (Visitors Blocked)" toggle now actually blocks visitors. The public food/general booking pages read `settings.food_bookings_open`/`general_bookings_open` as anon to decide whether to swap the form for the "bookings closed" notice, but the anon RLS allowlist on `settings` never included those two keys — the read always failed (masked by the catch whose logging v5.1.10 had already improved), so the forms stayed open regardless of the toggle. Migration `20260718140000_allow_anon_read_booking_open_flags.sql` adds the two keys to the allowlist (their values are only the strings `'true'`/`'false'` — nothing sensitive; the v5.1.6 table-grant narrowing is untouched). Three new live-behavior tests in `tests/security.test.mjs` cover the exact page query as anon, the admin-toggle→anon-visible round trip, and that non-allowlisted settings rows stay hidden. Verified on the disposable test project first (full 92-test suite green), then applied to production and confirmed end-to-end with a real anon REST call.

### Changed

- New `.gitattributes` pins LF line endings for `*.sh` and `rls_grants_snapshot.txt`: a fresh Windows worktree checkout (`core.autocrlf=true`) materialized them with CRLF, which broke `check-rls-grants-snapshot.sh` under bash (`$'\r': command not found`) and made its diff report a bogus full-file snapshot mismatch.

## [v5.1.11] - 2026-07-18

### Fixed

- `submit-booking` no longer records a nonexistent storage path when moving an uploaded document out of `temp/` fails: previously a failed move was only logged but the never-created destination path (`<bookingId>/<file>`) was still written to `bookings.documents`, so `get-booking-documents` couldn't sign it and the admin silently lost access to the trader's uploaded document (e.g. the required insurance certificate). A failed move now keeps the still-valid `temp/` source path instead — nothing cleans up `temp/`, so the file remains signable and viewable by admins, just under its temp path. Covered by two new integration tests (success path and failed-move fallback); verified on the disposable test project before the production deploy.

## [v5.1.10] - 2026-07-18

### Fixed

- Client catch blocks no longer swallow the underlying error: the password-update toast now includes the laundered cause (`safeError`) and logs the full error, the public forms' bookings-open check logs the real message instead of an unstringified object, and `shared.js`'s reminder/status-update handlers log the full error alongside their existing toasts. (Found the hard way: two live failures on 2026-07-18 were undiagnosable from the generic messages.)

### Changed

- Extracted the FSA hygiene-ratings and Google Maps reviews sections out of `js/shared.js` into `js/fsa-ratings.js` and `js/google-reviews.js` (verbatim move, no behavior change); `shared.js` drops from ~810 to 400 lines.

### Security

- Removed the `cdn.tailwindcss.com` runtime script from all pages — every page now uses the compiled `css/output.css` only — and dropped that origin from every page's CSP `script-src`/`style-src`, eliminating a third-party supply-chain exposure and the "should not be used in production" console warning. Also renamed the package from the historical `test-deploy-tailwinds-change` and removed the stale hardcoded `v3.0` from page footers.

## [v5.1.9] - 2026-07-18

### Security

- Revoked `anon`'s grant on the three id sequences behind `audit_logs`/`booking_locations`/`email_queue` (previously full `rwU`, letting `anon` call `nextval()`/`setval()`/`currval()` directly). No PostgREST surface exposes a sequence, so this was never a live exploit path — pure hygiene, closed because `anon` has zero legitimate reason to ever trigger `nextval()` on any of the three (none of the underlying tables allow `anon` to INSERT, following the narrowing already done in v5.1.6). `authenticated`/`service_role` grants on these sequences are unaffected. This closes the last remaining item from the interrupted table-grant-narrowing effort (v5.1.5–v5.1.9). Verified live via `pg_class.relacl` on both the test project and production.

## [v5.1.8] - 2026-07-18

### Security

- Closed the last gap in this project's default-privilege posture: `ALTER DEFAULT PRIVILEGES` now also revokes `authenticated`'s automatic grant on new functions/tables/sequences, mirroring the `anon` fix from v5.1.3. Objects created as `postgres` (how every migration in this repo creates them) were still auto-granting `authenticated` essentially full access at creation time — every migration already states its `authenticated` grant explicitly by hand, so this only removes a redundant default that could have silently over-granted a future object whose migration forgot the explicit grant. Non-retroactive; no existing grant changes. Verified live via `pg_default_acl` on both the test project and production.

## [v5.1.7] - 2026-07-18

### Security

- Narrowed `authenticated`'s table grants, the same defense-in-depth pattern already applied to `anon`. Unlike `anon`, `authenticated` needs broad CRUD for the admin app, so every table was traced individually (real client write call sites plus RLS) rather than revoked wholesale: `audit_logs`/`email_queue` to SELECT+INSERT, `booking_locations`/`location_power`/`locations`/the three public info views to SELECT-only (their writes route through `SECURITY DEFINER` RPCs or don't exist at all), `bookings`/`hcc_checks` to SELECT+INSERT+UPDATE, `email_templates` to SELECT+UPDATE, and `payments` to SELECT+UPDATE+DELETE (no INSERT — all payment-row creation is `SECURITY DEFINER`). `performers`/`schedules` were deliberately left untouched, since both are shared with a separate external app this repo can't audit. Full test suite green on both the test project and production (89 tests, 10 new); one real gap caught mid-verification (a test using the authenticated client as a shortcut for what's actually a service-role-level write) was fixed in the test, not by re-widening the grant.

## [v5.1.6] - 2026-07-18

### Security

- Narrowed the remaining tables/views where `anon` held `GRANT ALL`: `anon` now has zero table-level privileges on `audit_logs`, `email_templates`, and `hcc_checks` (no RLS policy ever let anon through any of them), and SELECT-only on `booking_locations`, `location_power`, `locations`, `public_bookings_info`, `public_performer_info`, and `public_schedule_info` (each already SELECT-only or read-only by RLS/view intent). Also revoked a vestigial `TRIGGER` privilege `anon` still held on `bookings`/`performers`/`schedules` — inert, since that privilege only gates `CREATE TRIGGER` DDL, not whether existing triggers fire. Every anon-reachable trigger chain and client call site was traced first to confirm nothing depended on the removed grants; `performers`/`schedules`' deliberate column-level anon grants were left untouched. Applied and verified on both the disposable test project (79-test suite green) and production, with an independent read-only query confirming the final live state matches intent exactly. `authenticated`/`service_role` grants are unaffected.

## [v5.1.5] - 2026-07-18

### Security

- Narrowed the `payments` table grant: `anon` no longer holds `GRANT ALL`. RLS already blocked every anon read/write via the "Admin only payments" policy, but the table grant was the sole thing standing behind it — a bad policy edit or an accidental `DISABLE ROW LEVEL SECURITY` would have handed anon full read/write on the table that records who paid what for a stall booking. `anon` now has zero table-level privileges on `payments`, confirmed by trace: no trigger touches the table, every write path is `SECURITY DEFINER` and already denies anon at the function level, and no client code (public or admin) ever queries `payments` as anon. `authenticated`/`service_role` are unaffected. Applied and verified on both the live and disposable test projects; full 70-test suite green on the test project before the live push.

## [v5.1.4] - 2026-07-17

### Fixed

- Password-reset links now work end-to-end. The v5.1.2 client-side fix was necessary but insufficient: the hosted Supabase Auth **Site URL** and **redirect allowlist** (dashboard config, not in this repo) still pointed at the deleted `feststallbookingsystem.vercel.app` deployment, so Supabase rejected the (correct) client-supplied redirect and fell back to the dead domain. Both now point at `https://app.ellastreet.co.uk`; verified end-to-end — the recovery link redirects to the live admin panel and the "Set New Password" flow renders. If the domain ever migrates again, Authentication → URL Configuration in the Supabase dashboard must be updated by hand.

### Security

- Narrowed the `settings` table grants from `GRANT ALL` to what each role's RLS policy can actually allow through: `anon` is now SELECT-only, `authenticated` SELECT/INSERT/UPDATE (all the admin UI uses). Previously the RLS policy was the single point of failure standing between `anon` and write access to the table holding the Zoho/Stripe/SerpAPI credentials. Applied and verified on both the live and disposable test projects.

### CI

- Bumped `actions/checkout` and `actions/setup-node` to v5, clearing the Node 20 deprecation warnings on every run.

## [v5.1.3] - 2026-07-17

### Security

- Revoked vestigial `anon`/`authenticated` grants on `cancel_booking_secure` and `get_next_booking_id` — both are only ever called server-side with the service-role key, so the anon/authenticated grants let a direct PostgREST caller skip the Turnstile check and generate booking IDs respectively. Also flipped this project's schema-level default privileges so new functions/tables/sequences no longer auto-grant `anon` access by default, closing a gap that had already been patched object-by-object twice before.
- Filtered `public_schedule_info` to match its sibling `public_performer_info` (`status IN ('Scheduled','Paid') AND deleted_at IS NULL`) — it previously had no filter at all, so every schedule slot was publicly visible regardless of the performer's status, including soft-deleted performers.
- Added baseline security headers via `vercel.json` (`X-Frame-Options`, a `frame-ancestors 'none'` CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`, `Permissions-Policy`) — closes a clickjacking gap the existing per-page meta-tag CSPs couldn't cover, since `frame-ancestors` is ignored when set via `<meta>`.

### Testing

- Added admin-access coverage for the Email Queue viewer and behavioral CORS tests confirming the Edge Functions never regress to a wildcard origin.

### Cleanup

- Extracted the `escapeHtml` helper duplicated across four Edge Functions into a shared `_shared/format.ts`.
- Added a pre-commit/CI guard flagging `innerHTML` assignments with unescaped dynamic content, mirroring the existing sibling-Edge-Function-call guard.

### Documentation

- Warned in the Disaster Recovery Runbook that the database backup dump is itself a full credential store (live API secrets, bank details, stallholder PII) and should be handled accordingly.

## [v5.1.2] - 2026-07-17

### Fixed

- Password-reset and new-user invite emails now build their redirect link from the canonical production domain instead of `window.location.origin`. Requesting a reset while the admin panel happened to be loaded from a stale domain (an old Vercel preview/default-alias, for example) baked that dead domain into the emailed link, which then 404s.

## [v5.1.1] - 2026-07-17

### Security

- Restricted `Access-Control-Allow-Origin` on all seven browser-facing Edge Functions (`submit-booking`, `cancel-booking`, `get-reviews`, `get-booking-documents`, `create-checkout-session`, `queue-bulk-email`, `send-email`) to the production app origin, via a new shared `_shared/cors.ts` constant, instead of a `'*'` wildcard — including on functions that require an admin Bearer token. Not exploitable today, since the JWT is attached explicitly by JS rather than auto-sent like a cookie, but tightens things for defense-in-depth. `stripe-webhook` is unaffected — it's called server-to-server by Stripe, not from a browser.

## [v5.1.0] - 2026-07-17

### Admin tools

- Added an Email Queue browse view (`email_queue.html`) — admin-only, reusing the audit-log page's search/filter/pagination pattern. Best-effort email sends (booking confirmations, payment requests, cancellations) already logged their outcome to `email_queue` with an error message on failure, but nothing surfaced it short of querying the table directly or digging through Edge Function logs. Linked from the admin hub's "More Tools" page.

## [v5.0.1] - 2026-07-17

### Security

- Fixed four `innerHTML` call sites that interpolated dynamic values without escaping them, found during a periodic audit of the project's `escapeHtml()` convention:
  - The public visitor map's toast reflected the raw search-box term unescaped (XSS via the search input, no authentication required)
  - The login page's password-reset confirmation reflected the raw email input unescaped
  - The email template admin sidebar rendered a template's subject line unescaped (stored XSS between admins via a saved template subject)
  - The Location Manager's desktop table left the booking ID unescaped in one place while escaping it everywhere else

## [v5.0] - 2026-07-16 - "Bank Transfers Supported"

### Manual bank-transfer payments (new)

- Admins can now record a bank-transfer payment directly in the Payments Tracker (reference + notes), which atomically confirms the booking and mirrors a successful Stripe payment — no second manual status change needed
- The `payment_requested` email now offers both a Stripe payment link and bank-transfer instructions (account name/sort code/account number), pulled from the settings table
- A confirmation email now sends automatically after a bank-transfer payment is recorded, same as a completed Stripe payment
- Consolidated the old freeform "bank details" setting into the same structured account fields used for bank transfers, removing the duplicate field from the Settings page
- Fixed dragging a booking onto "Payment Requested" on the Kanban board, which previously snapped back to Pending instead of opening the confirm dialog
- Widened the Payments dashboard so action buttons are no longer scrolled off-screen

### Stripe Checkout payment collection

- Added Stripe Checkout payment collection — confirming a chargeable booking immediately creates a Checkout Session and emails the stallholder a payment link
- Simplified the confirm workflow: removed the separate "Pre-Confirmed" step and the "Paid" status; a successful Stripe payment now atomically confirms the booking in one RPC
- Removed the "On Hold" booking status
- Hardened Stripe RPC/table grants against `anon`/`authenticated` access

### Security

- Removed `anon`'s direct access to `bookings`; added a `public_bookings_info` view exposing only what the visitor map needs
- Closed permission-audit RLS gaps in `performers` and `audit_logs`
- Closed a check-then-act race condition in booking-location conflict checking

### Admin tools

- Added an audit log viewer for reconstructing booking history
- Converted `bookings.is_charity` to a native enum and fixed a related `submit-booking` gap

### Cleanup

- Removed dead code left over from the Stripe restructuring: an unreachable chargeable-confirmation email path and an unused resend-confirmation function
- Dropped deprecated/unused columns, indexes, and functions (`bookings.location_id`, dead `audit_logs` columns, unused comparison operators)

### Documentation

- Wrote a disaster-recovery runbook based on a real restore drill
- Corrected HANDOVER.md's backup documentation

## [v4.0] - 2026-07-15

### Security

- Fixed mass-assignment vulnerability in the `submit-booking` Edge Function
- Required admin auth on the `get-reviews` Edge Function
- Re-validated `tempUuid`/file names server-side in `submit-booking`
- Pinned `search_path` on `SECURITY DEFINER` functions and dropped unused admin-check functions
- Made all three storage buckets private; migrated `esf-documents` to signed URLs
- Sanitized signed document URLs before inserting into `href`
- Revoked dormant `DELETE`/`TRUNCATE`/`MAINTAIN` grants from `anon`; tightened dormant grants on `user_roles` and `schedules`
- Dropped dead anon upload/download policies on the documents bucket
- Dropped redundant anon `SELECT` policy on `locations`, scoped to `LIVE`
- Enforced FK between `schedules.location` and `locations`

### Reliability

- Made bulk email and cancellation confirmation delivery reliable; fixed intermittent bulk email send failures
- Fixed `cancel-booking` and `submit-booking`'s received-email sends, which used a failure-prone sibling HTTP call
- Fixed double-prefixed URL in `get-booking-documents` signed links
- Dropped orphaned trigger functions with stale hardcoded URLs (including `queue_confirmation_email()`)
- Self-healed stale `Processing` rows in `claim_pending_emails`, locked down grants
- Closed a booking-ID race condition, caught by the new integration test suite
- Fixed proportional performer billing; tightened public application form privileges

### Infrastructure & testing

- Adopted Supabase CLI migrations for the public schema, closing the storage-schema migration gap
- Added a pre-commit guard against sibling Edge Function HTTP calls
- Added an RLS/grants snapshot test and expanded the integration suite with workflow and security tests
- Added a CI workflow (grep guard, RLS check, integration tests) with manual `workflow_dispatch` triggers

### Kanban board fixes

- Added the missing "Email Confirmed" button and Quill script, so bulk-emailing confirmed bookings works from the Kanban view
- Fixed a `window.closeModal is not a function` error that fired after emails were already queued
