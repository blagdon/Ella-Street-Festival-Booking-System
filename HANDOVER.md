# HANDOVER — Ella Street Festival Booking System

> Written for an AI coding agent picking this up cold. No prior context assumed.
> Last updated: 2026-07-15.
> `ARCHITECTURE.md` and `USER_GUIDE.md` also exist in this repo and are more exhaustive on
> some points, but **both contain stale information** — see [Gotchas](#9-gotchas) for the
> specific claims to distrust. Where this document and `ARCHITECTURE.md` disagree, trust
> this one (or better, trust the live code/database over either).

---

## 1. Project Overview

This is the **Ella Street Festival 2026 stall/trader booking system** — an admin panel that
lets festival organisers manage market-stall trader applications from public submission
through to confirmed pitch allocation and payment, plus a public-facing map and
self-service cancellation.

**Who uses it:**
- **Admins** — full access to every admin page (review applications, assign locations,
  track payments, manage email templates, manage users).
- **Stewards** — restricted to a single mobile-friendly page (`steward.html`) for
  assigning/clearing a pitch location on the day of the event.
- **The public** — three unauthenticated pages: two booking forms (food / general
  non-food) and a self-service cancellation page reached via an emailed link.

**Core flow:**
```
Public trader fills in booking form (Food or General)
        │
        ▼
Row inserted into `bookings` via the submit-booking Edge Function
"Application received" auto-email sent
        │
        ▼
Booking appears in the Kanban board (Pending column)
        │
        ▼
Admin reviews → changes status (Confirmed / Rejected / On Hold / HCC Checks / Cancelled)
        │                                   │
        ▼                                   ▼
Confirmation/rejection email sent    HCC Checks: tracked in hcc_checks,
automatically                        council email sent manually via
        │                            hcc_dashboard.html
        ▼
Admin assigns a physical pitch (location_admin.html)
        │
        ▼
Location-assignment email sent, occupancy conflict is DB-enforced
        │
        ▼
Payment tracked (payments.html) — paid / unpaid, bank reference
```

There's a second, mostly-separate feature in the same database for **performers**
(musicians/entertainers) with their own application form, cost-per-30-minutes billing,
and a `schedules` table for set times — see [Current State](#4-current-state) and
[Gotchas](#9-gotchas), this is not fully integrated into this repo yet.

---

## 2. Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | Vanilla HTML + JavaScript (ES Modules) | No framework, no bundler, no build step for JS |
| Styling | Tailwind CSS v4 | Compiled via PostCSS: `npm run build:css` / `watch:css` |
| Backend | Supabase (Postgres 17 + Auth + Storage + Edge Functions) | Project ref `rsnxhuhibglieofikkpo` |
| Edge Functions | Deno (TypeScript), via `supabase functions deploy` | See [Architecture](#3-architecture) |
| Hosting | Vercel | Static site + `/api/*.js` Node serverless functions + Vercel Cron |
| Email | Zoho Mail API (OAuth2 refresh-token flow) | Credentials cached in the `settings` DB table, not env vars |
| Bot protection | Cloudflare Turnstile | On public booking + cancellation forms |
| Maps | Leaflet.js | Visitor-facing map (`visitor_map.html`) |
| Testing | **None automated** | All verification is manual, via a local static server + the live Supabase project |

**Real dependency footprint is tiny** — `package.json` only has `tailwindcss`,
`postcss`, and `autoprefixer` as devDependencies. Public pages load the Supabase JS
client via a CDN `<script>` tag (not npm); admin pages use native ES module imports.

**Production URLs (verified live, not from stale docs):**
- App: `https://app.ellastreet.co.uk`
- Supabase: `https://rsnxhuhibglieofikkpo.supabase.co`
- Separate performer-application frontend (different repo, same database):
  `https://ellafestperformersadmin.vercel.app`

---

## 3. Architecture

### Repository layout
```
/
├── .github/workflows/ci.yml     ← CI: grep guard, RLS check, integration tests
├── *.html                       ← One file per page, repo root = deploy root
├── js/                          ← Admin JS modules (ES modules)
├── css/input.css, output.css    ← Tailwind source / compiled output
├── api/ping.js                  ← Vercel serverless fn — Supabase keep-alive cron
├── supabase/
│   ├── config.toml              ← Local Supabase dev config (Postgres 17)
│   ├── migrations/              ← Supabase CLI migrations (public schema + storage buckets/policies, since 2026-07-14)
│   └── functions/
│       ├── _shared/zoho.ts      ← Shared Zoho OAuth+send logic
│       ├── _shared/bucket.ts    ← Shared document-bucket-name resolver
│       ├── submit-booking/      ← Public: create a booking
│       ├── cancel-booking/      ← Public: self-service cancellation
│       ├── send-email/          ← Single choke point for all outbound email
│       ├── queue-bulk-email/    ← Admin: bulk-email confirmed bookings
│       ├── get-reviews/         ← Admin: Google Maps review lookup (SerpApi)
│       ├── get-booking-documents/ ← Admin: sign document storage paths for viewing
│       ├── create-checkout-session/ ← Admin: create a Stripe Checkout Session, email the payment link
│       └── stripe-webhook/      ← Public (Stripe-signature-gated): processes successful/expired payments
├── supabase-public.js           ← Credentials + config for PUBLIC pages (non-module)
├── email_templates.js           ← LEGACY fallback templates (real ones are in the DB)
├── vercel.json                  ← Vercel Cron config
├── payment_success.html / payment_cancelled.html ← Static, no-auth Stripe Checkout redirect targets
└── supabase/sql-archive/        ← Historical one-shot manual migration/fix scripts (see below)
```

### JS module dependency order (admin side)
```
config.js  (imports supabase-public.js's ESF_PUBLIC_CONFIG — no other deps)
    ↑
utils.js       (validation, escaping, sanitisation — no project deps)
    ↑
supabase.js    (client singleton, requireAuth(), signOut())
    ↑
api.js         (all DB reads/writes, audit-logs every mutation)
    ↑
shared.js / ui.js / nav.js
    ↑
[feature modules]  kanban.js, summary.js, locations.js, payments.js, stats.js, ...
    ↑
page-*.js      (one per HTML page — entry point, calls requireAuth() then initNavigation())
```

Every admin HTML page's only inline `<script>` is
`<script type="module" src="./js/page-xxx.js"></script>`. That file calls
`requireAuth('admin')` or `requireAuth('steward')` (from `js/supabase.js`) before
anything else runs; unauthenticated/wrong-role users are redirected to `login.html`.

**Public pages are different on purpose**: `General_Booking.html`,
`Food_Stall_booking.html`, `cancel_booking.html` are NOT ES modules — they load the
Supabase JS SDK from a CDN and `supabase-public.js` as a plain script, because they must
work with zero auth context. Security here is 100% RLS + Edge Function server-side
validation, not secrecy of the anon key (which is intentionally public).

### Settings-driven config
`js/config.js` and `supabase-public.js` hold **fallback defaults only**. The real source
of truth is the `settings` key/value table, loaded once per session via
`loadStallCosts()` (admin) / `loadPublicSettings()` (public) and cached in
`sessionStorage['ESF_SETTINGS_CACHE']`. Stall costs and allowed stall types have **no
hardcoded default at all** — they're `null`/`[]` until the settings table loads
(`getStallCost()` warns to console and returns `0` if called before that).

### Edge Functions (Deno, `supabase/functions/`)

| Function | Auth | Purpose |
|---|---|---|
| `submit-booking` | None (`--no-verify-jwt`) | Only path for creating a public booking. Rebuilds the row from an explicit allow-list (`sanitizeBookingInput()`) rather than trusting the request body — mass-assignment protection. Sends the "received" auto-email itself (`sendReceivedEmail()`, calls `sendViaZoho()` in-process, same as `queue-bulk-email`/`cancel-booking`). Stores uploaded document **storage paths** in `bookings.documents`, not public URLs (see the `esf-documents` privacy migration below). |
| `cancel-booking` | None (`--no-verify-jwt`), gated by Cloudflare Turnstile | Verifies the Turnstile token, calls `cancel_booking_secure()` RPC, then sends the cancellation-confirmation email itself (`sendCancellationEmail()`, calls `sendViaZoho()` in-process, same as `queue-bulk-email`). |
| `send-email` | Admin JWT **or** the raw `SUPABASE_SERVICE_ROLE_KEY` as Bearer token ("trusted service call") | The only function that actually talks to Zoho. Delegates to `_shared/zoho.ts`. |
| `queue-bulk-email` | Admin JWT only | Atomically inserts N `email_queue` rows as `Pending`, responds immediately, then drains them **in-process** (calls `sendViaZoho()` directly, not over HTTP) via `EdgeRuntime.waitUntil()` in the background. |
| `get-reviews` | Admin JWT or trusted service call | SerpApi Google Maps review lookup for a business name, used by the performer-review-check feature. |
| `get-booking-documents` | Admin JWT only | Resolves a booking's `documents` storage paths to time-limited (1hr) signed URLs via `createSignedUrls()` — `esf-documents` is a private bucket. Called from `js/shared.js`'s `populateDetailPane()` when rendering the Kanban/Summary detail pane. |
| `create-checkout-session` | Admin JWT only | Creates a Stripe Checkout Session for any not-yet-resolved booking (called directly from the chargeable-confirm modal, or again on "Resend Payment Request" from `Payment Requested`), saves the resolved `stall_cost`, updates the booking to `Payment Requested`, and emails the `payment_requested` template with the session URL. Picks the `stripe_secret_key_test`/`_live` settings-table row by whether `instance_prefix` contains `-DEV-` (or the `stripe_test_mode` override — see below). See [Stripe Payment Collection](#stripe-payment-collection) below. |
| `stripe-webhook` | None (`--no-verify-jwt`); gated instead by Stripe signature verification (tries the `stripe_webhook_secret_test` then `_live` settings-table rows) | On `checkout.session.completed`, calls `mark_stripe_payment_received()` then `finalize_stripe_confirmation()` RPCs, then best-effort emails `confirmed_chargeable` (deduped via `stripe_webhook_events`, in-process `sendViaZoho()`, never `functions.invoke`). No-ops on expired/failed payment events — the booking is already correctly sitting at `Payment Requested`. |
| `_shared/zoho.ts` | n/a (imported, not deployed) | Zoho OAuth2 token refresh/cache + send logic, shared by `send-email` and `queue-bulk-email`. |
| `_shared/bucket.ts` | n/a (imported, not deployed) | Resolves the document bucket name (env var, else `settings.bucket_name`, else `'esf-documents'`), shared by `submit-booking` and `get-booking-documents`. |
| `_shared/stripe.ts` | n/a (imported, not deployed) | Loads all four Stripe credentials from the `settings` table (`loadStripeSettings()`) and resolves test-vs-live mode (keyed off `instance_prefix` + the `stripe_test_mode` override, mirroring the DEV/LIVE convention elsewhere), single Stripe SDK import point. Shared by `create-checkout-session` and `stripe-webhook`. |

### Data flow / RPC pattern
Most reads/writes go straight through `js/api.js` against RLS-gated tables. Anywhere
that needs atomicity or a privilege check beyond plain RLS uses a `SECURITY DEFINER`
Postgres RPC function instead of a direct table write:
- `rpc_set_booking_locations(p_booking_id, p_location_ids)` — atomically replaces a
  booking's assigned pitches; does its own admin/steward role check.
- `cancel_booking_secure(p_token, p_reason)` — looks up + cancels a booking by its
  public `cancel_token`.
- `get_next_booking_id(p_prefix)` — generates the next sequential booking ID, table-locked
  to avoid races.
- `claim_pending_emails(p_batch_size)` — atomically claims a batch of `Pending`
  `email_queue` rows (`FOR UPDATE SKIP LOCKED`) so concurrent drain runs can't double-send.

### Migrations (Supabase CLI)
As of 2026-07-14, `supabase/migrations/20260714132316_baseline_schema.sql` captures the
full `public` schema (tables, types, functions, triggers, policies, grants) as a single
baseline, generated via `supabase db dump --schema public --linked` against the live
project and verified to apply cleanly to an empty schema (tested against a throwaway
project — see [Gotchas](#9-gotchas) for the one real issue that surfaced: never include
the `storage` schema in a dump meant to be replayed, it captures Supabase-internal
system objects like `storage.buckettype` that a migration has no permission to
recreate). This closes the gap flagged earlier in this document's history: before this,
the base schema wasn't reproducible from anything in this repo at all.

**New workflow going forward**: `supabase migration new <descriptive_name>` to scaffold
a timestamped file under `supabase/migrations/`, write the DDL there, then a human runs
`supabase db push` (reviews the diff first) to apply it to the live project — same
human-in-the-loop principle as before, just via the CLI instead of pasting into the SQL
Editor. **No agent should run `supabase db push` against the live project directly** —
same rule as the old convention, just a different mechanism for a human to trigger it.

**Resolved (2026-07-14)**: `supabase/migrations/20260714144652_storage_buckets_and_policies.sql`
covers the storage side — the three bucket definitions (`documents`,
`performer-documents`, `esf-documents`, all `public=false`) and the one RLS
policy on `storage.objects` (`"Strict Public Uploads"`), kept in a separate
file from the `public` baseline for the same reason: the `storage` schema
itself is platform-managed, and a migration can't touch its internal setup.
Verified against the disposable test project — including the realistic case
of an older backup whose `esf-documents` bucket was still `public=true` with
no size/type limits, correctly brought in line by the migration's upsert.

**The ~30 existing `fix_*.sql`/`add_*.sql`/`drop_*.sql` files (moved 2026-07-15 from the
repo root into `supabase/sql-archive/` for tidiness — a third-party review flagged the
root clutter) are kept as historical record**, not retroactively converted into
migrations — the baseline already captures their combined end-state, and their header
comments have real "why" context worth keeping. **Do not move them into
`supabase/migrations/`** — the Supabase CLI treats every file there as a pending
migration to replay via `db push`, and several of these contain DDL (e.g. `CREATE TYPE
... AS ENUM`) with no `IF NOT EXISTS` form that would fail against the live project the
same way the baseline migration itself did (see the Gotcha on `migration repair`). They
predate this workflow; don't add new ones going forward for schema changes covered by
the `public` schema — use a migration instead. Storage bucket/policy changes (until the
known gap above is closed) still follow the old convention: a fix file in
`supabase/sql-archive/`, run manually in the SQL Editor.

### Stripe Payment Collection

Added 2026-07-15. Inserts real online payment collection between "admin approves" and
"booking is Confirmed," without touching location allocation (a fully separate
`status='Confirmed'`-gated page/RPC) or the Rejected/Cancelled paths.

**Status chain**: `Pending → Payment Requested → Confirmed` (plus the existing
`On Hold`/`HCC Checks`/`Rejected`/`Cancelled` side-branches, unaffected). Two things NOT
implemented as literal new statuses, deliberately:
- "Submitted"/"Under Review" collapse into the existing `Pending` — every status
  transition is already a deliberate admin click, there's no automatic event to
  distinguish them.
- "Location Allocated" is **not** a status — it's the existing, already-separate
  `location_admin.html` process. Confirming this feature never touches
  `booking_locations`/`rpc_set_booking_locations` is the actual verification that
  location allocation is unaffected, not just an assertion.

**No intermediate "Pre-Confirmed" status — this was a same-day simplification.** The
feature originally landed with a deliberate two-step chargeable flow (`Pre-Confirmed`,
persisted with no email/Stripe call, then a separate "Request Payment" click). Later the
same day the admin asked for that collapsed into one step: confirming a booking as
chargeable now fires the Stripe Checkout Session and payment-request email immediately,
landing straight on `Payment Requested` — there is no click in between anymore. The
original two-step design's rationale (avoid confusing "confirmed" with "paid", let the
admin double-check the cost before Stripe is involved) is superseded by this explicit
instruction; the cost is still editable in the same `#confirmTypeModal` right up to the
moment the admin clicks — it's the *separate later click* that was removed, not the
review step itself.

**`js/kanban.js`/`js/summary.js`'s `finalizeConfirm(isChargeable)`** (triggered by the
same `#confirmTypeModal` as before, opened by the same button/drag-drop as before)
branches on the resolved cost, not just the admin's Free/Chargeable toggle: **free OR an
explicit `£0` override** goes straight to `Confirmed` exactly as before (unchanged
`finalizeConfirmation()` — payments row deleted if present, `confirmed_free` email);
**chargeable with cost > 0** now calls `js/api.js`'s `requestPayment(id, cost)` directly
(async — a real Stripe API round trip, not a synchronous local write), which invokes
`create-checkout-session` with the resolved cost in the request body. This closes a
pre-existing gap where "free" and "chargeable-with-£0" were indistinguishable except by
payments-row presence — `stall_cost === 0` is the actual free/skip-Stripe rule.
`create-checkout-session` writes the booking's `stall_cost` itself as part of the same
update that sets `status='Payment Requested'` — there's no separate persistence step
before it runs, so the Edge Function accepts an optional `cost` in its request body
(falling back to the booking's already-stored `stall_cost` for a plain "Resend Payment
Request" call, which doesn't pass one). If Stripe/email fails, the booking is left
exactly where it was (Pending/On Hold/HCC Checks) — the admin sees an error toast and can
retry from the same Confirm button, no stuck intermediate state possible.
`create-checkout-session`'s status check now only rejects bookings that are already
resolved (`Confirmed`/`Rejected`/`Cancelled`), rather than requiring a specific prior
status, since a payment request can now originate from `Pending`, `On Hold`, or
`HCC Checks` as well as being resent from `Payment Requested`.

**No intermediate "Paid" status either — this was a second same-day simplification,
right after the Pre-Confirmed one above.** The feature originally had `stripe-webhook`
make two separate top-level RPC calls — `mark_stripe_payment_received()` (→ `Paid`, with
the `payments` upsert) then `finalize_stripe_confirmation()` (`Paid` → `Confirmed`) — on
purpose, so a crash between the two would leave a real, visible, recoverable `Paid`
booking rather than an unreachable intermediate state (a Kanban "Mark as Confirmed"
recovery button existed specifically for this). The admin asked for `Paid` to be removed
entirely, so `stripe-webhook` now makes **one** call to `finalize_stripe_payment()`
(`20260715141600_stripe_atomic_payment_confirmation.sql` — drops the two old RPCs,
adds this one), which does the status update (`Payment Requested` → `Confirmed`,
`stripe_payment_intent_id`, `date_confirmed`) and the `payments` upsert inside a single
`SECURITY DEFINER` function call — i.e. one Postgres transaction. This actually closes
the crash gap rather than just making it recoverable: either both writes commit, or (on
any error) neither does and the booking is left exactly at `Payment Requested`, which
Stripe's own webhook retry (or "Resend Payment Request") already knows how to recover
from — no dedicated recovery button needed anymore, so `recoverStuckPaidBooking()` and
the "Mark as Confirmed" button are gone too. Same idempotency property as before, now via
one guard instead of two: `finalize_stripe_payment` no-ops (0 rows updated, no error)
unless the booking is still `Payment Requested` when it runs — this, not the
`stripe_webhook_events` table, is the real idempotency boundary for the financial state
change. `stripe_webhook_events` (RLS enabled, zero policies, `service_role`-only grant)
still exists purely to dedupe the **email send**: a retried/duplicate Stripe webhook
delivery would otherwise re-email the confirmation on every retry. Learned from the
Pre-Confirmed migration's own history: `finalize_stripe_payment`'s grants
`REVOKE ... FROM "anon", "authenticated"` **by name**, not just `FROM PUBLIC`, from the
very first migration this time — this project's schema-level `ALTER DEFAULT PRIVILEGES`
grants new functions directly to those roles regardless of a `PUBLIC` revoke (see the
Gotchas entry on this below).

**All four Stripe credentials live in the `settings` table, not Edge Function env
vars** — `stripe_secret_key_test`, `stripe_secret_key_live`, `stripe_webhook_secret_test`,
`stripe_webhook_secret_live`, all admin-editable via `settings.html`'s "Stripe Payments"
card (password-masked inputs, `js/page-settings.js`'s `initStripeSettings()`), loaded
server-side by `_shared/stripe.ts`'s `loadStripeSettings()`. This deliberately mirrors
the existing Zoho-credentials pattern (also settings-table, not env vars) rather than
`TURNSTILE_SECRET_KEY`'s pattern (env var) — the reasoning: like Zoho, these are values
an admin should be able to rotate or configure live through the UI, with zero CLI access
or redeploy needed, not fixed-per-environment values a human sets once via
`supabase secrets set`. None of the four keys are in the `settings` RLS policy's
anon-readable whitelist — same protection level as `zoho_*` (admin-authenticated reads
via the "Allow admins full access to settings" policy, or `service_role` from an Edge
Function, only).

**Test/live mode is keyed off `bookings.instance_prefix`, plus one admin-editable
override**, mirroring the existing DEV-vs-LIVE convention (`locations.dataset`,
`fetchPayments()`'s instance filtering): `-DEV-` always → Test mode, no override
possible. Every other instance (FOOD/NONFOOD/MISC, "Food/General") → Live mode by
default, **unless** the `stripe_test_mode` settings-table row (text `'true'`/`'false'`,
same "Stripe Payments" card toggle) is `'true'` — turning that on forces Test mode for
Food/General bookings too, e.g. a full rehearsal before going live with real payments.
`_shared/stripe.ts`'s `resolveStripeMode(instancePrefix, forceTestModeSetting)`
implements this exactly; `create-checkout-session` is the only caller that reads the
setting — the webhook doesn't need it, since it already tries both Test and Live webhook
secrets (from `settings`, see above) regardless of which mode created the session. One
Stripe webhook endpoint URL receives both Test-mode and Live-mode events (registered
separately under each mode in the Stripe Dashboard, each with its own signing secret) —
`stripe-webhook` tries both in turn. Note `stripe-webhook` now needs a Supabase client
(and therefore `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` — still genuine Edge Function
env vars, unaffected by this settings-table change) constructed **before** signature
verification, since the webhook secrets themselves come from a DB query.

**Checkout is hosted/redirect-only, deliberately not embedded Stripe.js** — the admin
clicks "Request Payment", the stallholder gets an emailed link, opens it, pays on
Stripe's own page, and is redirected to `payment_success.html`/`payment_cancelled.html`
(new, static, no-auth — purely informational, since the webhook, not the redirect, is
the actual source of truth). This means **no CSP changes were needed anywhere** — CSP
doesn't govern top-level navigation.

**Payment status visibility**: `payments.html`'s `fetchPayments()` (`js/api.js`) was
extended additively — its original behavior (only bookings with an existing `payments`
row) is untouched, **plus** `Payment Requested` bookings with no payments row yet (none
is created until the webhook succeeds) are now also included, flagged
`awaitingPayment: true` and rendered with a distinct "Awaiting Payment" badge rather than
"UNPAID".

**New `bookings` columns**: `stripe_checkout_session_id`, `stripe_payment_intent_id`,
`stripe_payment_requested_at` (all nullable). **New table** `stripe_webhook_events`
(email-send dedup ledger, see above). **No new columns on `payments`** — reused as-is
(`bank_ref` holds `'Stripe: ' + payment_intent_id`, `editor` holds `'Stripe (automatic)'`
to distinguish from a manually-entered admin name). **New email template**
`payment_requested` (seeded by the migration, since `email_templates` has no "create
new" UI — only `email_admin.html`'s editor for existing rows), placeholder
`{{payment_link}}` added alongside the existing set.

**`Payment Requested` is deliberately NOT a Kanban drag target** (`js/kanban.js`'s
`initDragula()`) — only `Pending`/`On Hold`/`HCC Checks`/`Confirmed`/`Rejected`/
`Cancelled` are. Dragging a card into it would fake a transition with no real Stripe
Checkout Session behind it. Cards can still leave that column via the detail-pane
buttons, just not by dragging in. Dropping onto `Confirmed` opens the same
`#confirmTypeModal` as clicking the Confirm button — the admin's Free/Chargeable choice
then decides whether it lands on `Confirmed` directly or on `Payment Requested` via Stripe.

**Testing**: `tests/stripe-payment.test.mjs`, same disposable-test-project guard as the
rest of `tests/`. The `create-checkout-session` success-path tests additionally need
both new functions deployed to the **test** project, and a Stripe Test-mode key/webhook
secret in place — `scripts/seed-test-project.mjs`'s `ensureSettings()` now does this
automatically (upserts `stripe_secret_key_test`/`stripe_webhook_secret_test` from
`TEST_STRIPE_SECRET_KEY`/`TEST_STRIPE_WEBHOOK_SECRET`, same `.env.test`/CI-repo-secret
values as before — only how they're delivered changed, from `supabase secrets set` to a
settings-table row, consistent with the rest of this section). Deploying the two
functions there is still a one-time manual step, same as `TURNSTILE_SECRET_KEY`'s
existing test-project setup.

---

## 4. Current State

### Fully built and working
- Public booking forms (Food, General/Non-Food) + admin-added Misc entries
- Kanban board and searchable/sortable list ("Summary") views, both with bulk-email
- Location Manager — multi-location assignment per booking, occupancy-conflict enforced
  at the DB level, Google My Maps CSV export, search/sort
- Payment tracking, statistics/charts, visitor map (Leaflet)
- Stripe Checkout payment collection (Pending → Payment Requested → Confirmed, fired
  immediately on a chargeable confirm, one atomic RPC on successful payment), test/live
  mode via `instance_prefix`, idempotent webhook — see
  [Stripe Payment Collection](#stripe-payment-collection) above
- HCC (Hull City Council food safety) check workflow — manual, environment-aware email send
- Email template admin (`more.html`), user role management, steward mobile view
- Booking cancellation (public self-service link) with automatic confirmation email
- Bulk email to all confirmed bookings — queues server-side first, survives the admin
  closing their browser mid-send, drains in the background (fixed and verified this session)

### Partially built / not integrated into this repo
- **Performer booking feature**: `performers` and `schedules` tables exist in the same
  Supabase project with full RLS policies and billing logic, but **nothing in this
  repo's JS reads or writes them**. The public application form lives in a **separate**
  Vercel deployment/repo (`ellafestperformersadmin.vercel.app`) that writes directly to
  the shared `performers` table. There is no performer-management admin UI here yet — if
  that's wanted, it hasn't been started.

### Explicit stub / legacy
- `email_templates.js` (repo root) — hardcoded fallback template strings, kept for
  reference only. The real, editable templates live in the `email_templates` DB table.

### Known gaps (not bugs, just unbuilt)
- No `email_queue` browse/retry admin UI — `js/page-email-admin.js` only manages
  `email_templates`, despite `ARCHITECTURE.md` claiming otherwise.
- No error/alerting integration (Slack/Discord/Sentry) for Edge Function failures —
  explicitly deferred by the project owner ("I'll do it later").
- ~~No real automated test suite~~ — **resolved 2026-07-14**. All three steps of
  the original plan (grep guard → RLS snapshot test → real integration tests)
  are done, and CI runs all of them on every push — see
  [Testing](#testing) in section 6 for what each covers, and Next Steps items
  16–17, 21, and 22 for the full history (including a real booking-ID
  concurrency bug the integration tests found and fixed along the way).
- ~~No formal migrations tool, base schema never committed anywhere~~ — **resolved
  2026-07-14**, see [Migrations](#migrations-supabase-cli) in section 3. A baseline
  migration now exists and was verified to actually reproduce the schema (tested
  against a real, throwaway Supabase project after local Docker validation proved
  blocked by an environment issue — see Gotchas). Remaining gap: the `storage` schema
  (bucket policies) isn't covered by the baseline yet — still root-level fix files.

---

## 5. Data Model

### `bookings` — the central table
One row per application, all types share this table, distinguished by `instance_prefix`
(`ESF26-FOOD-`, `ESF26-NONFOOD-`, `ESF26-MISC-`, `ESF26-DEV-`). Key columns: `id` (text
PK, e.g. `ESF26-FOOD-0042`), `status` (`Pending`/`Payment Requested`/
`Confirmed`/`Rejected`/`Cancelled`/`On Hold`/`HCC Checks` — see
[Stripe Payment Collection](#stripe-payment-collection) for `Payment Requested`), `business_name`,
`owner_name`, `email`, `stall_cost`, `cancel_token`, `rejection_reason`,
`stripe_checkout_session_id`, `stripe_payment_intent_id`, `stripe_payment_requested_at`
(all nullable, added 2026-07-15). **`bookings.location_id` still exists as a column
but is deprecated** — see below. `documents` (`text[]`) stores **storage paths into
the (private) `esf-documents` bucket**, not public URLs — resolved to a signed URL on
demand by the `get-booking-documents` Edge Function.

### `booking_locations` — replaces the old CSV location column
Join table: `(booking_id, location_id)`. Superseded `bookings.location_id` (which used
to be a comma-separated string, e.g. `"A12, A13"`) this session. **All writes go through
the `rpc_set_booking_locations()` RPC** — there's no direct-write RLS policy, so don't
`INSERT`/`UPDATE` this table directly. A `booking_locations_check_conflict` trigger
blocks assigning the same pitch to two different `Confirmed` bookings **within the same
dataset** (see the DEV/LIVE note below).

### `locations` — pitch reference data
**Primary key is the composite `(id, dataset)`, not `id` alone.** `id` values (e.g.
`"A12"`) are only unique within a `dataset` (`DEV` or `LIVE`) — DEV and LIVE pitches are
seeded independently and could collide on `id`. This is why `booking_locations` has no
FK to `locations` (a plain `location_id → locations.id` FK isn't even possible without a
unique constraint on `id` alone) and why `schedules.location` needed a `dataset` column
added before it could get a composite FK.

### `payments`
One row per chargeable booking that has a payment resolved one way or another:
`booking_id` (FK/PK), `paid` (boolean), `date_paid`, `bank_ref`, `editor` — amount is
read from `bookings.stall_cost`, not stored redundantly here. A free/£0 booking never
gets a row at all. Reused as-is for Stripe payments (no schema changes) — a successful
Stripe payment upserts `paid=true, bank_ref='Stripe: '+payment_intent_id,
editor='Stripe (automatic)'` via the `mark_stripe_payment_received()` RPC.

### `stripe_webhook_events`
Pure email-send dedup ledger for `stripe-webhook` (`event_id` PK, `event_type`,
`received_at`). RLS enabled, zero policies — `service_role` (the webhook, only) bypasses
RLS entirely; `anon`/`authenticated` get no access at all. **Not** the idempotency
mechanism for the actual payment processing — see
[Stripe Payment Collection](#stripe-payment-collection).

### `email_queue`
Doubles as a send log and (for bulk sends) a real queue. Columns: `recipient`,
`subject`, `body`, `status`, `error_message`, `instance_prefix`. **`status` has four
values, not two**: `Pending` → `Processing` (bulk-send claim step, see
`claim_pending_emails()`) → `Sent` or `Error`. Individual sends (booking
confirmation/rejection/location emails, the "received" auto-responder, cancellation
confirmation) are all send-then-log — they call Zoho synchronously and insert the row
with the *final* status already known. Only the bulk-email path (`queue-bulk-email`)
ever inserts a genuinely `Pending` row that something processes later.

### `email_templates`
Editable via `more.html`. `id` (template key, e.g. `application_received`,
`confirmed_chargeable`, `rejected`, `cancellation_confirmed`, `location_update`,
`payment_reminder`, `payment_requested`), `subject`, `body_html` — both support
`{{placeholder}}` substitution (`owner_name`, `business_name`, `booking_id`,
`cancel_link`, `cost`, `bank_details`, `location_id`/`location_display`, `reason`,
`payment_link` — the last one only populated by `create-checkout-session` for
`payment_requested`). No "create new" UI exists — a new template id must be seeded via
migration/SQL, as `payment_requested` was.

### `audit_logs`
Append-only. Every admin mutation writes here via `api.js → auditLog()`:
`action`, `target_id`, `user_email`, `details` (JSON), `instance`.

### `hcc_checks`
Created when a booking's status moves to `HCC Checks` (client-side, in
`updateBookingStatus()`). Council-notification email is a **manual** admin action on
`hcc_dashboard.html`, not automatic — see [Gotchas](#9-gotchas) for why.

### `user_roles`
`id` (matches Supabase Auth `user.id`), `role` (`admin` or `steward`). Backs every
role-check policy in the database, via the `check_user_role()` / `get_is_admin()`
`SECURITY DEFINER` functions.

### `settings`
Generic key/value config table (see [Settings-driven config](#settings-driven-config)
above). Keys currently in use include `stall_cost_food/general/dev`,
`allowed_stall_types`, `festival_display_name`, `base_url`, `cancel_url`, `bank_details`,
`map_center_lat/lng`, `hcc_council_email`, `stripe_test_mode` (boolean as text,
Food/General Stripe test-mode override), `stripe_secret_key_test/live`,
`stripe_webhook_secret_test/live` (the actual Stripe credentials themselves — see
[Stripe Payment Collection](#stripe-payment-collection)), plus all `zoho_*`
credentials/cached tokens.

### `performers` / `schedules` — separate feature, same database
`performers`: application data (`name`, `email`, `phone`, `cost_per_30min`, `status`
enum `Applied`/`Scheduled`/`Paid`/etc., `insurance_*`, `total_cost` — computed by
`calculate_performer_total_cost()`, billed proportionally to duration). `schedules`:
`performer_id` FK, `start_time`/`end_time`, `location` (FK to `locations(id, dataset)`,
composite). **Not referenced anywhere in this repo's JS** — see [Current State](#4-current-state).

---

## 6. Setup Instructions

### No environment variables needed for the frontend
All Supabase credentials are intentionally public, hardcoded in `supabase-public.js`
(the anon key is meant to be client-visible — RLS is the real security boundary, not
secrecy). There is no `.env` file to create for local frontend dev.

### Running it locally
```bash
npm install
npm run build:css      # or: npm run watch:css   (compiles css/input.css → css/output.css)
npx http-server .      # or any static file server — no build step for the JS/HTML
```
Then open the served root — `login.html` for admin, or any of the public booking forms
directly. There's no `.claude/launch.json` committed; if you're driving this via a
browser-automation tool, set one up pointing at the static server.

Local dev always talks to the **live hosted Supabase project** in practice during this
project's history (not the local `supabase start` stack) — `supabase/config.toml` exists
and is configured (Postgres 17, ports 54321–54329) but there's no meaningful seed data,
and all real work this session was done directly against the hosted project via the
Supabase SQL Editor (for SQL) and the `supabase` CLI (for Edge Function deploys).

### Deploying an Edge Function
```bash
supabase functions deploy <function-name>
# submit-booking, cancel-booking, and stripe-webhook specifically need:
supabase functions deploy submit-booking --no-verify-jwt
supabase functions deploy cancel-booking --no-verify-jwt
supabase functions deploy stripe-webhook --no-verify-jwt
```
Requires the CLI to be logged in and linked to the project (`supabase login`,
project ref `rsnxhuhibglieofikkpo`). The CLI version used this session (`v2.72.7`) does
**not** support `supabase functions logs` — use the Supabase Dashboard's
Functions → *name* → Logs tab instead.

### Stripe credentials (one-time, per environment)
**Not an Edge Function secret** — set these via the admin UI, `settings.html`'s "Stripe
Payments" card (password-masked fields, "Save Stripe Settings"), which upserts four
`settings` rows: `stripe_secret_key_test`, `stripe_secret_key_live`,
`stripe_webhook_secret_test`, `stripe_webhook_secret_live`. This deliberately mirrors how
Zoho's credentials already work (also settings-table, not `supabase secrets set`) — an
admin can configure/rotate these live, with no CLI access or redeploy needed. The two
webhook secrets come from registering the deployed `stripe-webhook` URL as an endpoint
**separately** under both Test mode and Live mode in the Stripe Dashboard — one URL, two
registrations, two secrets. For the disposable test project
(`qeplpcnrkgpaawfyliap`), `scripts/seed-test-project.mjs` does the equivalent
automatically (test-mode credentials only, from `TEST_STRIPE_SECRET_KEY`/
`TEST_STRIPE_WEBHOOK_SECRET`) — see [Testing](#testing) below.

### Creating an admin/steward user
1. Create a Supabase Auth user (dashboard, or let them sign up if signup is enabled —
   **check first**, it was found enabled-by-accident and disabled this session).
2. Add a row to `user_roles` with their auth `user.id` and `role = 'admin'` or
   `'steward'` — via `manage_users.html` or directly in SQL.

### Testing
No unit test suite exists for the frontend. Verification of anything not covered by
the integration suite below is manual: run locally, log in with real admin/steward
credentials against the live project, exercise the actual flow in a browser, and
check the affected table's state directly in the Supabase Table Editor or SQL Editor
afterward.

**All three steps of the grep-guard → RLS-snapshot-test → real-integration-tests plan
are done** as of 2026-07-14, and **all three run automatically in CI on every push**
(`.github/workflows/ci.yml` — `grep-guard`, `rls-grants-check`, `integration-tests`
jobs; needs the six repo secrets described under `test:integration` below). Verified
with a real run via `gh run watch` — all three green.
- A git pre-commit hook (`.githooks/pre-commit`, wired up via `core.hooksPath` —
  auto-configured by `npm install`'s `postinstall` script) blocks any commit
  containing `functions.invoke(` inside `supabase/functions/`. That exact
  pattern (calling a sibling Edge Function over HTTP instead of shared
  in-process logic) caused three real bugs in one session — see the Gotcha below.
- `npm run check:rls-grants` (`scripts/check-rls-grants-snapshot.sh`) diffs the
  live project's RLS policies + grants against the checked-in
  `rls_grants_snapshot.txt`. Run manually (hits the network) whenever you want
  to check "did our access-control posture actually change" without a fresh
  live schema dump. A diff means something changed — review it, then
  `npm run check:rls-grants -- --update` and commit the refreshed snapshot if
  the change is expected.
- `npm run test:integration` (`node --test --test-concurrency=1`, Node's
  built-in `node:test`) runs three test files:
  - `tests/integration.test.mjs` — the deployed `submit-booking`,
    `cancel-booking`, and `queue-bulk-email` Edge Functions, plus the
    `get_next_booking_id`/`booking_locations_check_conflict`/
    `claim_pending_emails` database logic. This is where the retry-on-conflict
    fix for the booking-ID race (see [Next Steps](#8-next-steps) item 18) came
    from, caught by an actual concurrent-submission test, not code review.
  - `tests/workflow.test.mjs` — the full admin lifecycle (create → confirm →
    assign a location → move to a different one → record payment → move to
    HCC Checks → cancel), calling the same table/RPC operations `js/api.js`
    does, through a real signed-in admin session.
  - `tests/security.test.mjs` — behavioral RLS/column-grant checks against
    the real REST API as an actual anon caller: `bookings`/`performers` are
    visible only through their permitted columns (selecting a
    disallowed column like `email` is rejected outright, not silently
    dropped — column-grant-restricted tables error on `select('*')` rather
    than omitting columns, learn this the hard way once and it explains a
    few early test failures below), non-`Confirmed`/non-`Scheduled` rows are
    invisible, `locations`' `DEV` rows never appear, and `user_roles`/
    `email_queue` reject anon entirely (zero table grants, not just
    RLS-filtered). This is the permanent version of the ad-hoc curl checks
    used to verify the `locations` DEV/LIVE fix earlier this session.

  **`--test-concurrency=1` is required, not optional** — Node's test runner
  runs separate test *files* concurrently by default, but all three files
  share one remote disposable database. Found live: `integration.test.mjs`'s
  cleanup wildcard deleted `security.test.mjs`'s and `workflow.test.mjs`'s
  fixture rows mid-run when they happened to share the `ESF26-TEST%` prefix,
  producing confusing failures that had nothing to do with the app. Any new
  test file added here needs either a unique-enough ID prefix or to just rely
  on concurrency staying pinned to 1.

  **Runs only against the disposable "test backup" project
  (`qeplpcnrkgpaawfyliap`), never the real one** — every test file/script
  hard-refuses to run if the configured URL doesn't contain that project ref.
  One-time setup before it'll work:
  1. `supabase link --project-ref qeplpcnrkgpaawfyliap`, then deploy the three
     functions there too: `supabase functions deploy submit-booking
     --no-verify-jwt`, same for `cancel-booking`, and
     `supabase functions deploy queue-bulk-email` (no flag).
  2. `supabase secrets set TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
     --project-ref qeplpcnrkgpaawfyliap` — Cloudflare's official
     [always-passes Turnstile test secret](https://developers.cloudflare.com/turnstile/troubleshooting/testing/),
     not a real key and not a CAPTCHA bypass — it's Cloudflare's own sanctioned
     mechanism for testing Turnstile-gated flows.
  3. Create `.env.test` (gitignored, never commit it) with
     `TEST_SUPABASE_URL`, `TEST_SUPABASE_ANON_KEY`, `TEST_SUPABASE_SERVICE_ROLE_KEY`
     (from `supabase projects api-keys --project-ref qeplpcnrkgpaawfyliap`), and
     `TEST_ADMIN_EMAIL`/`TEST_ADMIN_PASSWORD` (anything — the seed script
     creates this user).
  4. `npm run test:setup` (`scripts/seed-test-project.mjs`) — idempotent, creates
     the test admin auth user + `user_roles` row, and the minimum
     `settings`/`email_templates` rows the functions need to run at all.
  5. `npm run test:integration`.

  **Deliberately no `zoho_*` settings are seeded** — every email-send attempt
  during tests is expected to fail and get logged as `email_queue.status='Error'`,
  which is itself a real, valuable path to test (the exact shape of bug fixed
  three times earlier this session) — and it means test runs never have the
  side effect of sending a real email to anyone.

---

## 7. Conventions

### Commits
Short conventional-ish prefixes: `fix:`, `feat:`, `security:`, `refactor:`, `chore:`,
followed by a specific, imperative summary. Body text (when present) explains **why**,
not what — the diff already shows what. Example from this repo's actual history:
```
fix: bulk email intermittent send failures

queue-bulk-email's background drain loop was invoking send-email as a
separate Edge Function over HTTP for every recipient, which
intermittently failed under load with no response at all once firing
many sequential calls in a row. Extracted the Zoho-sending logic into
a shared module both functions use, so the drain loop calls it
in-process instead of making a sibling HTTP call per recipient.
```
Security-relevant fixes historically avoided naming the exact exploit in the commit
message/PR body before the fix was confirmed live (e.g. "tightened database access
policies" rather than describing the specific hole) — kept generic even after, as a
habit.

### SQL fix files (historical) / migrations (current)
`.sql` files named `verb_target.sql` (`fix_bookings_rls_exposure.sql`,
`add_schedules_location_fk.sql`, `drop_unused_admin_functions.sql`), archived in
`supabase/sql-archive/` (moved there from the repo root 2026-07-15), are the
pre-2026-07-14 convention: header comment block (what/why), the DDL, a `-- VERIFY:`
query, handed to a human to paste into the SQL Editor, confirmed working, then
committed. These still exist as historical record — **never move them into
`supabase/migrations/`**, the CLI would try to replay them as pending migrations (see
the note under [Migrations](#migrations-supabase-cli)). **The current convention for
anything touching the `public` schema or storage buckets/`storage.objects` policies** is
`supabase migration new <name>` under `supabase/migrations/`, applied via a human
running `supabase db push` — same draft/review/confirm/commit shape, different
mechanism. Keep `storage` and `public` changes in separate migration files (see
[Migrations](#migrations-supabase-cli) for why) — never dump the full `storage` schema
into one, only the bucket rows and `storage.objects` policies that are actually ours.

### No inline event handlers
CSP (`index.html` and every other page's `<meta http-equiv="Content-Security-Policy">`)
has no `'unsafe-inline'` for `script-src`, so `onclick=`/`onchange=` attributes are
**broken by policy**, not just discouraged. Use `addEventListener` — the established
pattern is one delegated listener per page on `document.body` checking
`e.target.closest('[data-action="..."]')`.

### Validation is allow-list, not block-list
Public Edge Functions (`submit-booking`) rebuild the row to insert field-by-field from
an explicit allow-list (`sanitizeBookingInput()`), never spread/insert the raw request
body — this was a real fixed mass-assignment vulnerability class, don't reintroduce it.

### Audit everything
Every admin mutation in `api.js` calls `auditLog(action, targetId, details)`. Treat a
new mutation with no audit call as incomplete.

### No TypeScript on the frontend
Plain JS + JSDoc comments for the admin/public site. Edge Functions are TypeScript
(Deno). No linter/formatter config is committed (no ESLint/Prettier config found).

---

## 8. Next Steps

Nothing is actively mid-implementation as of this handover — the most recent body of
work (this session) was a full security/reliability hardening pass, now complete,
tested live, and deployed. In order, what was just finished:
1. Normalized `bookings.location_id` into the `booking_locations` join table
2. Externalized hardcoded config (stall costs, stall types, map center, festival name)
   into the `settings` table
3. RLS/grant hardening across most tables (`bookings`, `email_queue`, `performers`,
   `schedules`, `booking_locations`, `user_roles`, etc.)
4. Mass-assignment fixes on `submit-booking` and the public performer-application INSERT
5. `SECURITY DEFINER` `search_path` pinning; dropped 3 confirmed-dead admin-check
   functions and 4 confirmed-dead/superseded email-trigger functions
6. Fixed performer cost calculation (was silently zeroing non-30/60-minute bookings)
7. Added the missing `schedules.location → locations` FK
8. Made cancellation-confirmation email actually send (was queued by a DB trigger with
   no processor, silently never delivered)
9. Made bulk email reliable: server-side atomic queue + background drain, fixed two
   real bugs found while implementing it (missing `Authorization` header in
   `EdgeRuntime.waitUntil()`, and unreliable rapid-fire sibling-function HTTP calls)
10. Closed the same sibling-function HTTP gap in `cancel-booking`'s
    `sendCancellationEmail()` — now calls `sendViaZoho()` in-process instead of
    `functions.invoke('send-email', ...)`, matching `queue-bulk-email`

11. `fix_anon_dormant_table_grants.sql` — revoked leftover `DELETE`/`TRUNCATE`/
    `MAINTAIN` table-level grants to `anon` on `bookings` and `performers` (dormant,
    no RLS policy grants anon a DELETE command on either table, but the same "future
    policy change silently inherits it" risk already fixed for INSERT/UPDATE
    elsewhere). Run by the project owner in the SQL Editor and confirmed live via a
    fresh schema dump — anon's grants on both tables now show only column-scoped
    SELECT/INSERT plus table-level `TRIGGER`.
12. Storage bucket privacy hardening — `documents`, `performer-documents`, and
    `esf-documents` were all `public = true` (any object readable by an
    unauthenticated URL, no RLS involved since bucket-level `public` bypasses it
    entirely). `documents` held 17 real applicant-uploaded insurance PDFs, publicly
    reachable. Three-part fix:
    - `fix_orphaned_bucket_public_exposure.sql` — sets `documents` and
      `performer-documents` private. **Run and confirmed live** — neither bucket is
      referenced anywhere in this repo (the performer feature lives entirely in the
      separate `ellafestperformersadmin.vercel.app` app), so this had no functional
      impact here. If that separate app ever relied on public URLs for these buckets,
      it would need its own signed-URL fix — not visible from this repo.
    - `esf-documents` (this repo's own bucket, actively used by the public booking
      forms + the admin document links in `js/shared.js`) needed actual code changes
      before it could go private, since the app was storing/rendering full public
      URLs directly:
      - New `_shared/bucket.ts` (bucket-name resolver, extracted out of
        `submit-booking` so `get-booking-documents` can share it).
      - `submit-booking` now stores the bare storage **path** in
        `bookings.documents`, not a public URL.
      - New `get-booking-documents` Edge Function (admin-JWT-gated) resolves paths to
        1-hour signed URLs via `createSignedUrls()`.
      - `js/shared.js`'s `populateDetailPane()` now calls that function for
        path-shaped `documents` entries, while still rendering old full-URL entries
        directly (backward-compatible with pre-migration bookings).
      - **Both SQL files run; database/storage state verified live.**
        `backfill_booking_document_paths.sql` ran first — confirmed via a live
        schema dump that no `bookings.documents` entry contains the old
        `/storage/v1/object/public/esf-documents/` URL prefix anymore (e.g.
        `ESF26-FOOD-0005` now holds bare
        `ESF26-FOOD-0005/1777627505556_Event_Set_Up_2.jpg`). Then
        `fix_esf_documents_bucket_private.sql` ran — `esf-documents` now shows
        `public = false` in `storage.buckets`, same as `documents` and
        `performer-documents`. All three buckets are private.
      - **Not independently verified in the browser** — I confirmed the DB/storage
        state directly (schema dumps), not the live `kanban_m.html`/`summary.html`
        UI myself (no admin credentials). If document links ever appear broken for
        an existing booking, check whether its `documents` entries actually got
        backfilled to paths, and whether `get-booking-documents` returns a
        non-null signed URL for them.
13. `fix_documents_bucket_object_policies.sql` — the bucket-privacy pass above (item
    12) set `documents`' `public` flag to `false`, but that alone didn't stop `anon`
    reaching it: two `storage.objects` RLS policies (`"Give anon users access to JPG
    images in folder flreew_0"`, `"Performer insurance downloads flreew_0"`) still let
    any anon/authenticated caller upload arbitrary files (no type restriction despite
    the name) into `documents/performer-insurance/` and list/download everything
    there — RLS on `storage.objects` applies regardless of the bucket's public flag.
    Confirmed dead before dropping: `documents/performer-insurance/` had no upload
    since 2026-02-16, while the sibling `performer-documents` bucket (which has a
    proper `allowed_mime_types` restriction) has uploads as recent as 2026-06-21 — the
    live performer-application app moved to it months ago. These were the *only*
    `storage.objects` policies referencing the `documents` bucket at all. Run and
    verified live.
14. Found and fixed a bug in `get-booking-documents` (introduced by item 12):
    `createSignedUrls()` already returns a full absolute URL internally (it builds it
    as `` `${this.url}${signedURL}` `` inside the SDK), but the function additionally
    prefixed `supabaseUrl` on top, producing a malformed URL like
    `https://project.supabase.cohttps://project.supabase.co/storage/...` that failed
    to open. Found live when the project owner clicked "Open Document" in Kanban and
    got a browser DNS error; confirmed the exact cause against the `storage-js`
    source, fixed, redeployed, and the owner confirmed the link opens correctly now.
15. `drop_queue_confirmation_email_function.sql` — a fifth orphaned "queue the
    application-received email" trigger function (`queue_confirmation_email()`),
    missed by both the item-5 cleanup (which dropped four siblings doing the exact
    same superseded job) and `fix_function_search_path.sql` (which only pinned
    `search_path` on functions still actually in use — this one should have been
    dropped, not patched). Confirmed via a full `pg_trigger` dump that nothing calls
    it; the real "received" auto-email is `submit-booking`'s `sendReceivedEmail()`.
    Run and verified live.
16. Fixed `submit-booking`'s `sendReceivedEmail()` — same sibling-function HTTP call
    pattern as items 10 and (originally) `queue-bulk-email`, and this one **actually
    failed live**: a real food stall submission (`ESF26-FOOD-0028`) got
    `email_queue.status='Error'`, `'Edge Function returned a non-2xx status code'` for
    its "Application Received" email. Diagnosed by reading `email_queue` directly
    (fastest path to the real error — `supabase functions logs` isn't supported by
    this CLI version). Fixed to call `sendViaZoho()` directly, deployed, and
    confirmed no `functions.invoke('send-email'` calls remain anywhere in
    `supabase/functions/`.
17. Adopted Supabase CLI migrations for the `public` schema — see
    [Migrations](#migrations-supabase-cli) in section 3 for the full writeup.
    `supabase/migrations/20260714132316_baseline_schema.sql` is committed and verified
    (against a real, disposable Supabase project, not local Docker — see the Gotcha
    below about why). Going forward, `public`-schema changes use
    `supabase migration new` + `supabase db push` instead of a new root-level fix file;
    storage bucket/policy changes still use the old convention until that gap is
    closed (not started).
18. Step 3 of the automated-tests plan: a real integration test suite
    (`tests/integration.test.mjs`, Node's built-in `node:test`, run via
    `npm run test:integration`) against the deployed `submit-booking`,
    `cancel-booking`, and `queue-bulk-email` Edge Functions, plus the
    `get_next_booking_id`/`booking_locations_check_conflict`/`claim_pending_emails`
    database logic. **Found a real, previously-unknown concurrency bug** in the
    process: two simultaneous submissions to the same `instance_prefix` could get
    the same "next" booking ID and race to insert it, since
    `get_next_booking_id()`'s table lock only covers that single RPC call — it's
    released before `submit-booking`'s separate `INSERT` runs. One of the two
    concurrent submitters got a raw `duplicate key value violates unique
    constraint "bookings_pkey"` 500 instead of a successful submission. Fixed by
    retrying the generate-ID-then-insert cycle (up to 5 attempts) on a `23505`
    conflict, with file-uploads moved to storage *after* the insert succeeds
    (rather than before) since the booking's real id isn't settled until then.
    Verified against the disposable test project (10/10 tests green across 4
    consecutive runs, including the concurrency test) before deploying the same
    fix to the live project. See [Testing](#testing) in section 6 for how to run
    this suite and what setup it needs.
19. Closed the storage-schema migration gap: `supabase/migrations/20260714144652_storage_buckets_and_policies.sql`
    covers the three bucket definitions and the one `storage.objects` RLS
    policy, kept separate from the `public` baseline for the same
    platform-managed-schema reason. Verified against the disposable test
    project, including the realistic case of the project's older
    `esf-documents` bucket (still `public=true`, no size/type limits) being
    correctly brought in line by the migration's upsert. **Pushed to the live
    project and verified (2026-07-14)** — the initial `db push` attempt
    failed on the *other* migration (`20260714132316_baseline_schema.sql`,
    `ERROR: type "performance_type" already exists`): unlike the storage
    migration, the baseline contains raw `CREATE TYPE ... AS ENUM`, which has
    no `IF NOT EXISTS` form in Postgres, so it can never be re-applied as real
    DDL against the same live project it was dumped from — it only works
    against a genuinely empty schema (which is why it validated cleanly
    against the reset test project earlier, but not here). Fixed by marking it
    applied without re-running it (`supabase migration repair --status
    applied 20260714132316`, since the live schema already reflects its
    content), then re-running `db push`, which correctly skipped the baseline
    and applied the storage migration for real. `supabase migration list`
    and a fresh bucket dump both confirm: both migrations show applied, and
    all three buckets are unchanged (original `created_at` preserved,
    confirming a clean upsert `UPDATE`, not a fresh insert). **If this repo's
    schema is ever rebuilt from scratch on a fresh project, the baseline
    migration works as intended — this repair step is only needed because it
    was being retrofitted onto a project that already had the schema live.**
20. Fixed `locations`' duplicate/unscoped anon SELECT policy (`"Public view
    locations"` and `"anon_select_locations"`, both `USING (true)`) — scoped
    the surviving policy to `dataset = 'LIVE'` so `DEV` pitch rows stop being
    publicly queryable; the actual public-map use case (`LIVE`) is untouched.
    Tested directly against the live REST API with the anon key: an
    unfiltered query and an explicit `dataset=eq.LIVE` query both return
    exactly 140/140 rows, and an explicit `dataset=eq.DEV` query returns `[]`.
    **Process miss, corrected**: this is a `public`-schema RLS change and item
    17's own convention says exactly this category should be a migration, not
    a new root-level fix file — it was done as a fix file
    (`fix_locations_redundant_anon_policy.sql`) anyway, and wasn't logged here
    either, both caught after the fact. Retroactively added
    `supabase/migrations/20260714152302_locations_scope_public_view_to_live.sql`
    with the same DDL, verified against the disposable test project. Unlike
    the baseline's `CREATE TYPE` issue, this DDL (`DROP POLICY IF EXISTS` +
    `CREATE POLICY`) is genuinely idempotent, so no `migration repair`
    shortcut was needed. **Pushed to the main project and verified** —
    `supabase migration list` shows all three migrations applied there, and a
    fresh dump confirms the policy state is unchanged/correct.
21. Expanded the integration test suite with two new files:
    `tests/workflow.test.mjs` (full admin lifecycle: create → confirm →
    assign → move location → record payment → HCC check → cancel) and
    `tests/security.test.mjs` (behavioral anon-access checks against the real
    REST API — see [Testing](#testing) in section 6 for exactly what each
    covers). Found and fixed two bugs in the test suite itself along the way,
    neither an app problem: (1) Node's test runner runs separate test files
    concurrently by default, and `integration.test.mjs`'s cleanup wildcard
    was broad enough to delete the new files' fixtures mid-run once their ID
    prefixes overlapped — fixed by pinning `test:integration` to
    `--test-concurrency=1` and narrowing that wildcard; (2) a `performers`
    fixture insert was silently failing on an unchecked `NOT NULL` violation
    (missing `description`/`performance_type`/`cost_per_30min`), producing a
    false-positive pass on the "not visible" test since the row never
    existed to begin with — fixed by providing the required columns and
    adding error checks to every fixture insert so a future silent failure
    like this surfaces immediately instead of masquerading as a passing
    assertion. All 27 tests green across 2 consecutive runs.
22. Added CI: `.github/workflows/ci.yml` runs three jobs on every push/PR
    (and on demand via `gh workflow run ci.yml` / the Actions UI, since
    `workflow_dispatch` is enabled) — the sibling-function grep guard (same
    check as `.githooks/pre-commit`, enforced here too since a local hook can
    be bypassed or just not installed on a fresh clone), the RLS/grants
    snapshot check against the live project, and the full `tests/` suite
    against the disposable test project. Needs six repo secrets:
    `SUPABASE_ACCESS_TOKEN` (a dedicated personal access token, generated
    specifically for this — not one of the auto-generated `cli_*` tokens
    from a local `supabase login` session) plus the five
    `TEST_SUPABASE_URL`/`TEST_SUPABASE_ANON_KEY`/
    `TEST_SUPABASE_SERVICE_ROLE_KEY`/`TEST_ADMIN_EMAIL`/`TEST_ADMIN_PASSWORD`
    values already used locally in `.env.test`. All set, verified with a real
    run (`gh run watch`) — all three jobs green.
23. Housekeeping (2026-07-15, prompted by a third-party review flagging root-directory
    clutter): moved all ~30 historical `fix_*.sql`/`add_*.sql`/`drop_*.sql`/
    `backfill_*.sql` files from the repo root into `supabase/sql-archive/` via `git mv`
    (history preserved). **Deliberately not moved into `supabase/migrations/`** — the
    Supabase CLI replays everything in that folder as a pending migration via `db push`,
    and several of these files contain non-idempotent DDL (`CREATE TYPE ... AS ENUM`)
    that would fail against the live project exactly as the baseline migration itself
    once did (see the `migration repair` Gotcha). No code/CI/docs referenced these files
    by path except this document, which has been updated throughout. Purely a file-move;
    no schema or application behavior changed.
24. Implemented Stripe Checkout payment collection — full write-up under
    [Stripe Payment Collection](#stripe-payment-collection) in section 3. New migration
    (`bookings` columns, `stripe_webhook_events`, two `SECURITY DEFINER` RPCs, seeded
    `payment_requested` template), two new Edge Functions (`create-checkout-session`,
    `stripe-webhook`) plus `_shared/stripe.ts`, two new static pages
    (`payment_success.html`/`payment_cancelled.html`), and updates to
    `js/config.js`/`api.js`/`shared.js`/`kanban.js`/`summary.js`/`payments.js` and their
    HTML pages for the three new statuses and payment-flow actions. Verified:
    `location_admin.html`/`js/locations.js`/`rpc_set_booking_locations` were not modified
    at all. Deployed and verified live end-to-end as of item 27 below.
25. Moved all four Stripe credentials (`stripe_secret_key_test/live`,
    `stripe_webhook_secret_test/live`) from Edge Function env vars into the `settings`
    table (new "Stripe Payments" card on `settings.html`), at the project owner's
    explicit request — also added the `stripe_test_mode` Food/General override toggle
    to the same card in the same pass. `_shared/stripe.ts` reworked around a single
    `loadStripeSettings()` DB call; `stripe-webhook` now constructs its Supabase client
    (needed to load the webhook secrets) **before** signature verification rather than
    after. `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are unaffected — still genuine env
    vars, this only applies to Stripe-specific credentials. `scripts/seed-test-project.mjs`
    updated to seed the test-mode pair into the disposable test project's `settings`
    table instead of expecting `supabase secrets set` there.
26. **Deployed and verified Stripe payment collection against the disposable test
    project** — migration pushed, both new functions deployed, real Stripe Test-mode
    Checkout Session created via `tests/stripe-payment.test.mjs` against a live Stripe
    test account. All 45 tests green (`npm run test:integration`). Found and fixed a
    real gap along the way: `20260715085816`'s `REVOKE ALL ... FROM PUBLIC` on the two
    new RPCs, and relying on "RLS enabled + zero policies" alone for
    `stripe_webhook_events`, did **not** actually block `anon` on this project —
    confirmed live, `anon` could call both RPCs directly and `SELECT` the ledger table
    with no error. Root cause: `REVOKE ... FROM PUBLIC` doesn't touch a role's own
    direct grant if that role was separately granted access via this project's
    schema-level `ALTER DEFAULT PRIVILEGES` at object-creation time — `anon`/
    `authenticated` need to be revoked **by name**, not just via `PUBLIC`. Fixed in
    `20260715123703_fix_stripe_anon_authenticated_grants.sql` (a new migration, not an
    edit to the already-applied one). **Worth checking whether the same gap exists on
    `claim_pending_emails`** (baseline migration, same `REVOKE ... FROM PUBLIC`-only
    pattern) — it was never actually tested for anon-rejection, unlike the new RPCs
    here; not fixed as part of this session since it's pre-existing code outside this
    feature's scope, but flagged for whoever picks this up next.
27. **Merged `stripe_integration` into `main` and verified the full flow live on
    production** (`app.ellastreet.co.uk`, project `rsnxhuhibglieofikkpo`) — both
    migrations pushed, both Edge Functions deployed, real credentials entered via
    `settings.html`. Walked a real `£1` Food-instance booking (with the
    `stripe_test_mode` override on, so it used the Test-mode key rather than a real
    Live one) through what was at the time a two-step Pre-Confirmed → Request Payment
    flow, then a genuine Stripe Checkout payment (test card `4242 4242 4242 4242`) →
    Paid → Confirmed, and confirmed `payments.html` shows a real row (`bank_ref` = the
    actual `pi_...` payment intent, `editor` = `Stripe (automatic)`). **The Pre-Confirmed
    step was removed later the same day** — see item 28 and
    [Stripe Payment Collection](#stripe-payment-collection) above; this entry is kept as
    an accurate historical record of what was actually verified at the time.
    **Found and fixed a second real gap this way** (the automated test suite couldn't
    have caught this — it never exercises a genuine signed webhook call end-to-end):
    the Stripe **webhook destination** that had been registered pointed at the
    disposable **test** project's URL (`qeplpcnrkgpaawfyliap`), not the live one — so
    the first live payment's webhook was never even delivered, and the booking sat
    stuck in `Payment Requested` indefinitely. Fixed by registering a second,
    dedicated destination in the Stripe Dashboard (Test mode) pointing at
    `https://rsnxhuhibglieofikkpo.supabase.co/functions/v1/stripe-webhook`, then
    updating `stripe_webhook_secret_test` in `settings.html` to that destination's own
    signing secret. **A related, more subtle failure surfaced immediately after**: even
    with the correct destination, the very first delivery attempts failed with
    `{"error": "Webhook signature verification failed."}` (visible in the Stripe
    Dashboard's Event deliveries tab for that destination) — caused by the wrong
    destination's secret having been copied into `settings.html` at first, since two
    similarly-named destinations now exist in the same Stripe Test-mode account.
    Re-copying the secret from the correct ("Live Project, Test Mode") destination and
    resending the failed event via Stripe's own "Resend" button (no new payment
    needed) confirmed the fix — the event then delivered successfully and the booking
    completed the full status chain. **Lesson for next time**: when multiple Stripe
    webhook destinations exist in one account (e.g. one per Supabase project), always
    double-check which destination's secret you're copying — the destination name
    alone is easy to mis-click between similar-sounding options. `email test`
    (`ESF26-FOOD-0022`) was intentionally left as a real Confirmed/Paid booking in the
    live database afterward as a working example, at the owner's choice.
28. **Removed the `Pre-Confirmed` status, same day as item 27** — the owner asked for
    the chargeable-confirm flow to fire the Stripe payment request immediately instead
    of requiring a separate later "Request Payment" click. `Pre-Confirmed` is gone from
    `js/config.js`'s `STATUS_LIST`/`STATUS_COLORS`, both Kanban columns, the Summary
    status filter, `js/kanban.js`/`js/summary.js`'s dragula containers/drop-intercept/
    `cardBorderClass`, and `js/shared.js`'s `sharedUpdateStatus` (its whole
    `'Pre-Confirmed'` branch deleted, along with the now-unused `js/api.js`
    `preConfirmBooking()`). The "Request Payment (Stripe)" button is gone too (its
    action now happens automatically); "Resend Payment Request" is unaffected (the
    stuck-`Paid` recovery button is addressed separately in item 29 below).
    `create-checkout-session` now accepts an optional `cost` in its request body (since
    there's no longer a step that persists `stall_cost` before it runs) and only rejects
    already-resolved statuses (at this point `Confirmed`/`Paid`/`Rejected`/`Cancelled`,
    later narrowed further by item 29) rather than requiring a specific prior status —
    see [Stripe Payment Collection](#stripe-payment-collection) above for the current
    flow. `tests/stripe-payment.test.mjs` fixtures updated accordingly; no DB migration
    needed (`bookings.status` is a plain text column, no CHECK constraint, so removing a
    value from the app-level allow-list needed no schema change) — worth a one-time
    manual check that no live booking was actually sitting in `Pre-Confirmed` at the
    moment this shipped (none was, per the item 27 verification booking already having
    completed its full chain to `Confirmed`).
29. **Removed the `Paid` status too, immediately after item 28** — the owner asked
    directly whether `Paid` was ever used; the honest answer was "yes, but only for a
    few milliseconds in the success path, as a crash-recovery window between two
    separate webhook RPC calls" (see the "No intermediate Paid status" paragraph in
    [Stripe Payment Collection](#stripe-payment-collection) above for the full
    before/after). Rather than just removing the status and losing that crash-recovery
    property, `mark_stripe_payment_received()` and `finalize_stripe_confirmation()` were
    replaced with one atomic `finalize_stripe_payment()` RPC (new migration
    `20260715141600_stripe_atomic_payment_confirmation.sql`, which also drops the two old
    functions) — a single `SECURITY DEFINER` call is one transaction, so the crash window
    disappears entirely rather than needing a manual recovery step. `Paid` is gone from
    `js/config.js`'s `STATUS_LIST`/`STATUS_COLORS`, the Kanban `Paid` column,
    `cardBorderClass`, the Summary status filter, `js/api.js`'s `fetchPayments()`
    awaiting-payment filter (now just `status === 'Payment Requested'`), and the
    "Mark as Confirmed" recovery button + `recoverStuckPaidBooking()` everywhere
    (`js/api.js`, `js/shared.js`, `js/kanban.js`, `js/summary.js`, `js/page-kanban.js`,
    `js/page-summary.js`). `create-checkout-session`'s already-resolved check is now just
    `Confirmed`/`Rejected`/`Cancelled`. `tests/stripe-payment.test.mjs`'s RPC tests
    rewritten for the single call.

**Explicitly deferred, not started:** Slack/Discord/Sentry-style alerting for Edge
Function errors — the project owner said "I'll do it later," don't assume it's wanted
now without asking.

**Open gap, not yet requested by the owner:** no admin UI in this repo for the
`performers`/`schedules` feature. If a future task asks to "add performer management"
or similar, that's this — check with the owner whether it should live in this repo
(new pages, following the exact same `page-*.js` + `requireAuth('admin')` pattern) or
stay in the separate `ellafestperformersadmin.vercel.app` codebase.

---

## 9. Gotchas

- **`locations`' primary key is `(id, dataset)`, not `id`.** Never assume a bare
  `location_id` is globally unique. `booking_locations.location_id` deliberately has no
  FK to `locations` for this reason (occupancy conflicts are enforced by a
  dataset-scoped trigger instead).

- **Two different "environment" axes, easy to conflate:** `bookings.instance_prefix` is
  4-way (`DEV`/`FOOD`/`GENERAL`/`MISC`), but `locations.dataset` and
  `schedules`/`booking_locations` conflict-checking only recognise 2-way `DEV`/`LIVE`.
  The collapse rule (see `booking_locations_check_conflict()`): any `instance_prefix`
  containing `-DEV-` maps to dataset `DEV`; everything else (`FOOD`, `NONFOOD`, `MISC`)
  maps to `LIVE`. Don't assume a 1:1 mapping between instance and dataset.

- **`bookings.location_id` (the old CSV text column) still exists but is dead** — don't
  read or write it; use `booking_locations` + `rpc_set_booking_locations()` exclusively.

- **`stall_cost === 0` is the actual free/skip-Stripe rule**, not the admin's
  Free/Chargeable toggle by itself — an explicit `£0` chargeable override is treated as
  free too. A `Confirmed` booking with `stall_cost === 0` and no `payments` row is
  correct, not a bug.

- **There is no `Paid` status — a successful Stripe payment goes straight from
  `Payment Requested` to `Confirmed` in one atomic RPC**, `finalize_stripe_payment()`
  (`stripe-webhook` → this one call → done). This used to be two separate RPC calls
  (`mark_stripe_payment_received()` then `finalize_stripe_confirmation()`) specifically
  so a crash between them left a recoverable intermediate `Paid` state — that design was
  deliberately replaced (see item 29 in Next Steps and
  [Stripe Payment Collection](#stripe-payment-collection)) with one atomic call instead,
  precisely so there's no intermediate state to get stuck in at all. **Do not re-split
  `finalize_stripe_payment()` back into two calls** without re-adding a `Paid`-equivalent
  recovery path — the whole point of merging them was to make a stuck state
  architecturally impossible, not just to shorten the code.

- **`REVOKE ALL ... FROM PUBLIC` alone does NOT lock `anon`/`authenticated` out of a new
  table or function on this project.** Confirmed live while testing the Stripe RPCs:
  `anon` could still call `mark_stripe_payment_received()`/`finalize_stripe_confirmation()`
  and `SELECT` from `stripe_webhook_events` despite both being `REVOKE ... FROM PUBLIC`
  (functions) or RLS-enabled-with-zero-policies (table, which just silently returns
  empty rows for a role with its own SELECT grant, rather than erroring). Root cause:
  this project's schema-level `ALTER DEFAULT PRIVILEGES` grants new objects directly to
  `anon`/`authenticated` at creation time — revoking `PUBLIC`'s blanket grant doesn't
  touch a role's own separate direct grant. **Any new table/function meant to be
  service_role-only needs an explicit `REVOKE ALL ... FROM "anon", "authenticated"` by
  name** (see `20260715123703_fix_stripe_anon_authenticated_grants.sql` for the fix, and
  the pattern to copy). `REVOKE` is a safe no-op if the grant didn't exist. **Not yet
  checked**: whether `claim_pending_emails()` (baseline migration, same `FROM PUBLIC`-only
  pattern) has the identical gap — it was never actually tested for anon-rejection.

- **The public Supabase anon key being visible in `supabase-public.js` is intentional**,
  not a leak to fix. All real protection is RLS + `SECURITY DEFINER` role-check functions.

- **`EdgeRuntime.waitUntil()` background tasks don't reliably auto-attach the
  `Authorization` header** when the task calls `supabase.functions.invoke()` on a
  sibling Edge Function — confirmed live (401 "Missing Authorization header" errors
  that only happened from inside a background task, never from normal synchronous
  request handling). Worse, even with the header fixed, **firing many sequential
  `functions.invoke()` calls at the same sibling function in a tight loop is
  unreliable** in this environment (intermittent total failures with no response at
  all). The fix that actually worked: extract the shared logic into
  `supabase/functions/_shared/` and call it **in-process**, not over HTTP, from any
  background/bulk code path. Follow this pattern for anything similar in future rather
  than re-adding retries/pacing around repeated sibling-function HTTP calls.
  `cancel-booking`'s `sendCancellationEmail()` was still doing the HTTP-hop
  `functions.invoke('send-email', ...)` as of the start of this session — same failure
  mode, just a single call instead of fifty, so much lower probability per invocation
  but not zero. Fixed to call `sendViaZoho()` directly, same as `queue-bulk-email`.
  `submit-booking`'s `sendReceivedEmail()` had the exact same unfixed pattern and
  **actually failed live** on a real food stall submission (`ESF26-FOOD-0028`,
  2026-07-14): `email_queue` logged the "Application Received" send as
  `status='Error'`, `error_message='Edge Function returned a non-2xx status code'`.
  Fixed the same way. **If you ever see this exact error message in `email_queue` or
  reported by a user again, grep for `functions.invoke('send-email'` across
  `supabase/functions/` first** — at three-for-three so far, any remaining direct
  HTTP call to `send-email` from another function is a live bug, not a hypothetical.

- **`submit-booking`'s booking-ID generation retries on conflict — don't "simplify"
  that away.** `get_next_booking_id()`'s `LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE`
  only holds for that single RPC call; it's released before `submit-booking`'s
  separate `INSERT` runs, so two concurrent submissions to the same
  `instance_prefix` can compute the same "next" id before either has inserted.
  Confirmed live via a real concurrency integration test (`tests/integration.test.mjs`)
  before it was fixed — one of two simultaneous submissions got a raw
  `duplicate key value violates unique constraint "bookings_pkey"` 500. Fixed by
  retrying the generate-ID-then-insert cycle (up to 5 attempts) on a Postgres
  `23505` (unique_violation), with file uploads moved to storage *after* the
  insert succeeds rather than before (the booking's real id isn't settled until
  then). If this code ever gets refactored back to a single generate-then-insert
  attempt with no retry, the race reopens — re-run
  `tests/integration.test.mjs`'s `get_next_booking_id concurrency` test to check.

- **`send-email` has a "trusted service call" bypass**: a request presenting the raw
  `SUPABASE_SERVICE_ROLE_KEY` as its Bearer token skips the admin-JWT check entirely.
  This is how `submit-booking`/`cancel-booking` (both public/unauthenticated) are
  allowed to trigger real email sends. Don't remove this without providing another way
  for those two functions to send email.

- **All three storage buckets (`documents`, `performer-documents`, `esf-documents`)
  are private as of this session** — don't assume `getPublicUrl()`/raw public URLs
  work for any of them. `esf-documents` document links go through the
  `get-booking-documents` Edge Function (admin-JWT-gated, returns 1-hour signed
  URLs); `js/shared.js`'s `populateDetailPane()` still has a fallback path that
  renders an entry directly if it happens to already be an absolute URL (harmless
  leftover from the migration — every row was backfilled to bare paths, but the
  fallback costs nothing to keep and protects against any row that somehow wasn't).

- **HCC council notification is manual by design — do not automate it.** An earlier,
  since-deleted `trigger_hcc_workflow()` DB trigger auto-emailed the real council on
  every status change to `HCC Checks`, with no DEV/LIVE awareness (would've emailed the
  real council from test data) and no audit log. It was removed as a landmine. The
  current, correct behavior is a manual "send" button on `hcc_dashboard.html` that
  redirects to the logged-in admin's own inbox when the active instance is `DEV`, and
  audit-logs every send.

- **`ARCHITECTURE.md` is stale — specific claims to distrust:**
  - Production URL listed as `stallbookingstailwinds.vercel.app` → actually
    `app.ellastreet.co.uk` (the old one is a disconnected, abandoned Vercel project).
  - Documents `bookings.location_id` as the live mechanism → superseded by
    `booking_locations`.
  - References `GAS/Main.gs` (Google Apps Script cron) as the keep-alive mechanism →
    deleted, replaced by `api/ping.js` + the Vercel Cron entry in `vercel.json`.
  - Says Email Admin "browses the email queue" → it only manages `email_templates`.
  - Lists `email_queue.status` as only `Sent`/`Error` → `Pending` and `Processing` also
    exist now (added for the bulk-email queue-and-drain mechanism).

- **RLS policies on `bookings`/`performers` look more permissive than they are —
  check column-level `GRANT`s before flagging anon exposure.** `anon`'s SELECT
  policies on both tables (`"Public see confirmed"` on `bookings`, `"Public row-level
  access for views"`/`"Public can view scheduled"` on `performers`) are row-scoped
  only, as RLS always is — but each table also has a column-restricted `GRANT SELECT`
  for anon (`bookings`: `id, business_name, description, stall_type, category,
  instance_prefix`; `performers`: `id, name, description, performance_type,
  performance_type_other, status`) that independently blocks reading `email`, `phone`,
  `address`, `owner_name`, `admin_notes`, etc., regardless of the RLS policy. A
  reviewer reading only `pg_policies` (not `information_schema.column_privileges`)
  will see full-row access and wrongly conclude PII is exposed — this happened once
  already this session (a third-party review flagged it as Critical; verified against
  the live schema and it was already fixed, see `fix_bookings_rls_exposure.sql` and
  `fix_performer_schedule_column_grants.sql`). Always check the actual column grants
  before acting on this class of report. The anon column-SELECT access on `bookings`
  is also genuinely used (`js/api.js`'s `fetchMapData()`, backing `visitor_map.html`),
  not dead — don't revoke it outright.

- **`public` schema has a real baseline migration (2026-07-14), and the `storage`
  gap is closed too (`20260714144652_storage_buckets_and_policies.sql`) — but
  `storage` schema migrations are a trap, don't include the full schema in a dump
  meant to be replayed.** The baseline was scoped to `public` only after an
  earlier attempt that included `storage` failed with `permission denied for
  schema storage` on `CREATE TYPE "storage"."buckettype"` — a Supabase-internal
  system type that every project already has, not something this project
  created. If you ever regenerate or extend either migration, scope dumps
  explicitly (`supabase db dump --schema public` / `--schema storage`, never
  both at once for a migration) and for storage, hand-extract only the bucket
  rows and `storage.objects` policies that are actually ours — never the
  schema/type/table-creation noise Supabase itself owns.

- **Neither baseline migration can be re-applied as real DDL against the same
  live project it was dumped from — `CREATE TYPE ... AS ENUM` has no
  `IF NOT EXISTS` form in Postgres.** Confirmed live: pushing
  `20260714132316_baseline_schema.sql` to the actual main project (after it had
  only ever been validated against a reset disposable project) failed with
  `ERROR: type "performance_type" already exists`, since the live project
  obviously already has every type/table the baseline defines. Fixed by marking
  it applied without re-running it: `supabase migration repair --status applied
  20260714132316` (safe specifically because the live schema already reflects
  that file's content), then a normal `supabase db push` picked up and applied
  the still-pending storage migration correctly. This `repair` step is only
  needed when retrofitting a baseline onto a project that already has the
  schema live — building a genuinely fresh project from these migrations
  needs no such workaround.

- **`supabase start` (local Docker stack) failed 3/3 times on this machine (Windows,
  Docker Desktop) with a host↔container networking error** — Postgres itself reaches
  "ready to accept connections" per its own container logs, but the CLI's own
  connection check from the host to `127.0.0.1:54322` fails immediately after with
  either a dial timeout or an unexpected EOF, tearing everything down before any
  migration is ever applied. Confirmed reproducible, not flaky — same failure point
  every time, including with `--debug`. This blocked local migration testing entirely;
  validation was done instead against a real (throwaway) hosted Supabase project via
  `supabase link --project-ref <other-project>` + `supabase db push`. If local Docker
  is needed again, this needs actual troubleshooting first (restart Docker Desktop
  itself, check Windows Firewall / WSL2 vEthernet adapter) — don't assume it'll work,
  and don't burn time retrying blindly more than once or twice.

- **File uploads**: 12MB limit, bucket `esf-documents`. `submit-booking` validates the
  temp-upload UUID and filenames server-side against strict patterns
  (`SAFE_TEMP_UUID_PATTERN`, `SAFE_FILENAME_PATTERN`) before moving them into the final
  storage path — never trust the client-sanitized values verbatim, they're trivially
  bypassable by calling the public endpoint directly.

- **The performer-application public form** (`ellafestperformersadmin.vercel.app/public/apply.html`)
  writes directly to this same project's `performers` table from a **separate**
  codebase/deployment. If you change `performers`' schema or RLS, that other app is a
  real, live consumer you won't see by grepping this repo.

- **`performers`/`schedules` are NOT dead/orphaned — they're a live feature with an
  admin UI in a different repo.** "Nothing in this repo's JS references them" (true)
  is not the same as "nobody uses them." A third-party review once suggested
  dropping the tables or revoking all anon/authenticated grants on the basis that
  they looked orphaned. Checked directly against the live data before doing
  anything: `performers` had 11 real applicant rows, most recently created
  **2026-06-21** (weeks before this check, not months), and `performer-documents`
  (the storage bucket the same app uploads insurance docs to) has uploads from the
  same date — this is an actively-used feature, just one this repo doesn't have a UI
  for. Dropping the tables would delete real people's live applications and break
  that other app's submission flow outright. Before ever touching `performers`/
  `schedules` schema, RLS, or grants, check actual row recency
  (`SELECT max(created_at) FROM performers`) — don't infer "dead" from an
  in-repo grep alone.
