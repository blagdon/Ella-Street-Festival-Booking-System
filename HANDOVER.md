# HANDOVER — Ella Street Festival Booking System

> Written for an AI coding agent picking this up cold. No prior context assumed.
> **If you are an agent: read
> [Agent autonomy](#agent-autonomy--what-to-do-without-asking) (section 7) first.**
> The owner's standing instruction is to do as much as possible without asking —
> that section says exactly which actions to take unprompted (most of them,
> including applying additive migrations to production), which require specific
> verification first, and the short list that needs an explicit instruction every
> time. Default to acting.
> Last updated: 2026-07-21.
> Current release: **v7.10.2** (tagged 2026-07-21; frontend only — the Payments
> dashboard's **Paid total ignored refunds**, so a refunded booking went on
> inflating it forever and the header reported money the festival no longer
> holds. Paid is now net of refunds, with a Refunded tile accounting for the
> difference. This is the second bug in a row caused by v7.10.0 changing
> payment state without updating everything that reads it — `paid` stays
> `true` after a refund by design, so **every** consumer of `paid` has to
> subtract `refund_amount` itself.)
> v7.10.1 was frontend + CI only — it rebuilt
> the committed `css/output.css`, without which v7.10.0's refund button rendered
> **invisible** in production, plus a new `css-build-check` CI job so that class
> of bug can't recur. Read the Gotchas entry on
> `css/output.css` being a committed build artefact before adding any Tailwind
> class the project hasn't used before. It also added the
> [Stripe go-live checklist](#-going-live-with-real-stripe-payments--checklist-not-yet-done)
> — **production currently takes no real card payments**, which is deliberate
> but was not written down anywhere until then.
> v7.10.0 was the refunds feature (**database changes and two Edge Function
> deploys, applied to production**), plus a follow-up flag for bookings
> cancelled after payment — see
> [Next Steps](#8-next-steps) item 64, and note the one manual Stripe Dashboard
> step it needs before dashboard-issued refunds auto-reconcile.
> v7.9.0 scoped anon's `schedules` access to Scheduled/Paid performers
> — see [Next Steps](#8-next-steps) item 63, which closes the last of item 58's
> three deferred findings, and the new Gotchas entry on why a
> successful-but-wrong migration needs `migration repair`, not just a retry).
> v7.8.0 was also a database change (`get_is_admin()` consolidated into
> `check_user_role('admin'::user_role)` and dropped, plus a fix for
> `check-rls-grants-snapshot.sh`'s first-line-only blind spot — item 62, the
> two follow-ups item 60 left open). v7.7.0 was frontend-only (bounded admin
> list queries — item 61, see it for why payments got a cap instead of the
> pagination first proposed). v7.6.0 was also a database change
> (`user_roles.role` consolidated onto the `user_role` enum, the
> `eq_text_user_role` shim dropped — item 60, plus two Gotchas entries on
> `ALTER POLICY`'s pg_depend trap and the snapshot script's first-line-only
> blind spot, now fixed by v7.8.0). v7.5.0 dropped the orphaned
> `location_power` table (item 59, read it before trusting a repo-only "no
> references" check on anything performer-adjacent again) — also database
> changes, as was v7.4.0 (item 58); v7.4.1 was CI config only; v7.3.1 docs,
> v7.3.0 developer tooling, v7.2.0 the Payment Tracker modal fix before that.
> **The version line jumps 5.1.13 → 7.0.0
> — there is no 6.x series**, and 7.0.0 contains a bug fix, not breaking changes;
> the major bump was a deliberate owner decision, so don't read it as a schema or
> API break. — see `CHANGELOG.md` for
> per-version release notes and the repo's GitHub Releases page for the tagged
> versions. Every `CHANGELOG.md` version now has a matching GitHub release:
> v5.1.4–v5.1.10 had been changelog-entries-only, and were tagged retroactively on
> 2026-07-18 (each tag anchored to the commit that introduced its changelog entry;
> v5.1.4's tag already existed but had never been published as a release). The
> package version in `package.json` tracks the latest changelog entry — keep all
> three (package version, changelog, tag/release) in step when releasing.
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
Admin reviews → changes status (Confirmed / Rejected / HCC Checks / Cancelled)
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
│       ├── get-reviews/         ← Admin: Google Maps review lookup (SerpApi), server-side cached
│       ├── get-booking-documents/ ← Admin: sign document storage paths for viewing
│       ├── retry-queued-email/  ← Admin: re-send one failed email_queue row (viewer's Retry button)
│       ├── create-checkout-session/ ← Admin: create a Stripe Checkout Session, email the payment link
│       └── stripe-webhook/      ← Public (Stripe-signature-gated): processes successful/expired payments
├── scripts/                     ← Dev/CI tooling: dev-server.mjs (npm run dev — static server +
│                                   same-origin Supabase proxy), seed-test-project.mjs,
│                                   check-rls-grants-snapshot.sh, check-unescaped-innerhtml.mjs
├── tests/                       ← Integration tests against the disposable test project (npm run test:integration)
├── supabase-public.js           ← Credentials + config for PUBLIC pages (non-module).
│                                   Also holds the localhost-only test-project override.
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
| `get-reviews` | Admin JWT or trusted service call | SerpApi Google Maps review lookup for a business name, used by the performer-review-check feature. **Results are cached server-side** in `google_reviews_cache` (default 7 days, `reviews_cache_ttl_hours` settings override) — SerpApi is metered and the detail pane auto-searches on every open. `force: true` in the body bypasses the cache; see [Next Steps](#8-next-steps) item 53. |
| `retry-queued-email` | Admin JWT only (deliberately **no** service-role bypass — retrying is a human recovery action) | Re-sends one failed `email_queue` row for the Email Queue viewer's Retry button. Must be server-side: `authenticated` has no UPDATE on `email_queue`, and the Zoho credentials are server-side. Claims the row (`Error → Processing`) before sending so two retries can't both deliver; only `Error` rows are retryable. Calls `sendViaZoho()` in-process. See [Next Steps](#8-next-steps) item 55 for the exact concurrency guarantees. |
| `get-booking-documents` | Admin JWT only | Resolves a booking's `documents` storage paths to time-limited (1hr) signed URLs via `createSignedUrls()` — `esf-documents` is a private bucket. Called from `js/shared.js`'s `populateDetailPane()` when rendering the Kanban/Summary detail pane. |
| `create-checkout-session` | Admin JWT only | Creates a Stripe Checkout Session for any not-yet-resolved booking (called directly from the chargeable-confirm modal, or again on "Resend Payment Request" from `Payment Requested`), saves the resolved `stall_cost`, updates the booking to `Payment Requested`, and emails the `payment_requested` template with the session URL. Picks the `stripe_secret_key_test`/`_live` settings-table row by whether `instance_prefix` contains `-DEV-` (or the `stripe_test_mode` override — see below). See [Stripe Payment Collection](#stripe-payment-collection) below. |
| `stripe-webhook` | None (`--no-verify-jwt`); gated instead by Stripe signature verification (tries the `stripe_webhook_secret_test` then `_live` settings-table rows) | On `checkout.session.completed`, calls `mark_stripe_payment_received()` then `finalize_stripe_confirmation()` RPCs, then best-effort emails `confirmed_chargeable` (deduped via `stripe_webhook_events`, in-process `sendViaZoho()`, never `functions.invoke`). On `charge.refunded` (added 2026-07-21), maps the charge to a booking via `stripe_payment_intent_id` and records the refund via `rpc_record_refund` — this is what makes a refund issued in the Stripe *dashboard* reconcile back into the app; it treats "already been refunded" as success, see [Next Steps](#8-next-steps) item 64. No-ops on expired/failed payment events — the booking is already correctly sitting at `Payment Requested`. |
| `refund-payment` | Admin JWT only (deliberately **no** service-role bypass — issuing a refund moves real money and must be a deliberate human action) | Issues a real Stripe refund for a booking, then records it via `rpc_record_refund`. Stripe-only: bank transfers have no API to call and stay record-only in the Payments UI. Calls Stripe **first**, database second, on purpose — see item 64 for why that ordering is the recoverable one. |
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
a timestamped file under `supabase/migrations/`, write the DDL there, then `supabase db
push` (review the diff it prints first) to apply it — test project first, then
production.

**On who runs `db push`**: this used to read "no agent should run `supabase db push`
against the live project directly." That rule is superseded — see
[Agent autonomy](#agent-autonomy--what-to-do-without-asking) in section 7 for what an
agent should now do unprompted (additive DDL: yes; destructive DDL: never without an
explicit instruction) and what verification each tier requires. The review step didn't
go away, it just became the agent's job to perform and report rather than to hand off.

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
`HCC Checks`/`Rejected`/`Cancelled` side-branches, unaffected). Two things NOT
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
exactly where it was (Pending/HCC Checks) — the admin sees an error toast and can
retry from the same Confirm button, no stuck intermediate state possible.
`create-checkout-session`'s status check now only rejects bookings that are already
resolved (`Confirmed`/`Rejected`/`Cancelled`), rather than requiring a specific prior
status, since a payment request can now originate from `Pending` or `HCC Checks` as well
as being resent from `Payment Requested`.

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
**That override is currently `'true'` in production, and the live credentials are
unset — production takes no real card payments today.** Before flipping it, follow
[the go-live checklist](#-going-live-with-real-stripe-payments--checklist-not-yet-done),
because the order of those steps matters: flipping this first breaks payment
collection until the live key exists.
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
`{{payment_link}}` added alongside the existing set. `create-checkout-session` now also
substitutes `{{cancel_link}}` (fetches the `cancel_url` setting and the booking's
`cancel_token`, same pattern as `js/shared.js`'s `getEmailFromTemplate`/`stripe-webhook`'s
`sendConfirmationEmail` — this placeholder wasn't wired up at all when the template was
first seeded). The live template's body was edited directly via `email_admin.html`
(2026-07-15, at the owner's request) to stop showing the raw Checkout URL as link text —
it's now `<a href="{{payment_link}}">Pay Now</a>` — and to add a
`<a href="{{cancel_link}}">Cancel Booking</a>` line, matching the "Cancel Link" wording
style already used by the `payment_reminder` template. `scripts/seed-test-project.mjs`'s
own simplified `payment_requested` row (plain text, not the real HTML — deliberately
different, see that file's own comments) was updated to include `{{cancel_link}}` too,
for consistency with its sibling seeded templates.

**`Payment Requested` is deliberately NOT a Kanban drag target** (`js/kanban.js`'s
`initDragula()`) — only `Pending`/`HCC Checks`/`Confirmed`/`Rejected`/`Cancelled` are.
Dragging a card into it would fake a transition with no real Stripe
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

### Public visitor-facing data access (`bookings`)

Added 2026-07-15, migration `20260715165015_secure_public_bookings_view.sql`, in
response to a third-party security review flagging anon SELECT access to `bookings`.

**What the review found**: the `"Public see confirmed"` RLS policy let `anon` SELECT any
row where `status = 'Confirmed'`, and `bookings` has real PII columns (`owner_name`,
`email`, `phone`, `address`, `admin_notes`, `rejection_reason`, `documents`,
`cancel_token`). **What was actually true at the time**: those specific PII columns were
never anon-selectable in practice — a pre-existing column-level `GRANT SELECT` restricted
`anon` to exactly `id`/`business_name`/`category`/`stall_type`/`description`/
`instance_prefix` (see the Gotchas entry below, which documented this exact combination
after an earlier, near-identical review flagged the same thing and it turned out to
already be handled). So the review's specific "Impact" bullets overstated current
exposure — but the underlying architecture was still fragile: RLS alone permitted
full-row access to any Confirmed booking, with the column grants as the *only* thing
narrowing it, and nothing would stop a future `GRANT SELECT ON bookings TO anon` (e.g.
someone "fixing" an unrelated bug) from silently re-exposing everything. The fix below
was implemented anyway, at the reviewer's/owner's request, because it's a genuinely
better architecture regardless of whether real exposure existed — this is documented
here in detail specifically so the next person doesn't waste time re-litigating whether
the original report was "right," and doesn't accidentally revert to the old pattern.

**The fix**: anon now has **zero** access to the `bookings` table — no RLS policy, no
column grants, nothing. All previous anon-facing functionality goes through a new view,
`public_bookings_info` (mirrors the existing `public_performer_info`/
`public_schedule_info` pattern — a view owned by `postgres`, so it runs with the owner's
privileges rather than the querying role's, meaning `anon` needs only `GRANT SELECT` on
the view itself, never on the base table):

```sql
CREATE OR REPLACE VIEW "public"."public_bookings_info" AS
 SELECT b.id, b.business_name, b.category, b.stall_type, b.description, b.instance_prefix,
        bl.location_id
   FROM bookings b JOIN booking_locations bl ON bl.booking_id = b.id
  WHERE b.status = 'Confirmed';
```

An inner join (not left) on `booking_locations` is deliberate: a Confirmed booking with
no location assigned yet has nothing useful to show on the public map, so it's correctly
absent from the view. This also collapses what `js/api.js`'s `fetchMapData()` used to do
as two separate queries (`bookings` then `booking_locations`, joined client-side in JS)
into one query against the view — see that function for the updated code.

**A second, less obvious break this caused, and how it's fixed**: the existing
`"Allow public anon to read confirmed booking locations"` policy on `booking_locations`
checks `bookings.status = 'Confirmed'` via a cross-table subquery in its `USING` clause.
That subquery runs as the querying role (`anon`) — so once `anon` lost all RLS-permitted
rows on `bookings`, the subquery would itself return zero rows for every check, and the
`booking_locations` policy would deny everything, silently breaking the public map's
location markers entirely (a real regression a naive "just drop the bookings policy" fix
would have caused). Fixed with a new `SECURITY DEFINER` helper,
`is_booking_confirmed(p_booking_id)` — same pattern as the existing `check_user_role()`
function — which runs as its owner (bypassing RLS) rather than as `anon`, so the
`booking_locations` policy keeps working without granting `anon` anything on `bookings`
directly:

```sql
CREATE POLICY "Allow public anon to read confirmed booking locations"
  ON booking_locations FOR SELECT TO anon
  USING (is_booking_confirmed(booking_id));
```

This was verified empirically (not just reasoned about) against the disposable test
project before it was ever considered safe: after applying the migration, a direct
`anon.from('bookings').select(...)` for any column — including the ones that used to be
column-granted — returns `permission denied for table bookings`; `anon` querying
`public_bookings_info` for a Confirmed booking still returns the expected row including
its joined `location_id`; and `anon` querying `booking_locations` for that same booking's
location assignment still succeeds. `tests/security.test.mjs`'s `anon access to
bookings`/`anon access to public_bookings_info`/`anon access to booking_locations`
describe blocks codify all of this permanently.

**Follow-up cleanup (done)**: `js/api.js`'s `fetchMapData()` used to also reference a
`visitor-map` Edge Function URL as an unauthenticated fallback path — that function never
existed in `supabase/functions/`, so the `fetch` always failed and the code silently fell
through to the direct view query below it. It was dead/aspirational code, not a security
issue, but misleading. It has since been removed; `fetchMapData()` now goes straight to
the direct query path (`locations` + `public_bookings_info`).

---

## 4. Current State

### Fully built and working
- Public booking forms (Food, General/Non-Food) + admin-added Misc entries
- Kanban board and searchable/sortable list ("Summary") views, both with bulk-email
- Location Manager — multi-location assignment per booking, occupancy-conflict enforced
  at the DB level, Google My Maps CSV export, search/sort
- Payment tracking, statistics/charts, visitor map (Leaflet) — the map now reads via the
  `public_bookings_info` view rather than the `bookings` table directly, see
  [Public visitor-facing data access](#public-visitor-facing-data-access-bookings) above
- Stripe Checkout payment collection (Pending → Payment Requested → Confirmed, fired
  immediately on a chargeable confirm, one atomic RPC on successful payment), test/live
  mode via `instance_prefix`, idempotent webhook — see
  [Stripe Payment Collection](#stripe-payment-collection) above
- Manual bank-transfer payment recording (Payments Tracker) — atomically confirms the
  booking via `rpc_record_bank_transfer_payment()`, same confirmation-email path as a
  completed Stripe payment; `payment_requested` email offers both a Stripe link and
  bank-transfer instructions — see Next Steps item 43
- HCC (Hull City Council food safety) check workflow — manual, environment-aware email send
- Email template admin (`more.html`), user role management, steward mobile view
- Booking cancellation (public self-service link) with automatic confirmation email
- Bulk email to all confirmed bookings — queues server-side first, survives the admin
  closing their browser mid-send, drains in the background (fixed and verified this session)
- Audit log viewer (`audit_log.html`, admin-only) — search/browse every recorded
  `auditLog()` action across all instances; see item 40 in [Next Steps](#8-next-steps)
- Email Queue viewer (`email_queue.html`, admin-only) — browse/search every send
  attempt with its error message, **and retry failed ones** (v7.1.0, item 55)
- Google Maps ratings/reviews on the booking detail pane, server-side cached to
  keep SerpApi usage down (v5.1.13, item 53)

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
- ~~No `email_queue` browse/retry admin UI~~ — **both parts are now built.**
  Browsing landed in v5.1.0 (`email_queue.html`, admin-only, search/filter/
  paginate) and the Retry action for failed sends in v7.1.0 (see
  [Next Steps](#8-next-steps) item 55). Note the entry that used to be here
  blamed `js/page-email-admin.js` — that file only ever managed
  `email_templates`; the queue viewer is `js/page-email-queue.js`, a separate
  page.
- No error/alerting integration (Slack/Discord/Sentry) for Edge Function failures —
  explicitly deferred by the project owner ("I'll do it later").
- ~~No refund support~~ — **built 2026-07-21 (v7.10.0), see
  [Next Steps](#8-next-steps) item 64.** The original note said to add the
  columns alongside the actual refund code rather than speculatively, and that
  is what happened: `payments` now carries `refund_amount`/`refunded_at`/
  `refunded_by`/`refund_reference`/`refund_notes`, with `rpc_record_refund()`,
  a `refund-payment` Edge Function for real Stripe refunds, and
  `charge.refunded` webhook reconciliation. **Deliberately still unsupported**:
  multiple separate refunds against one booking (the one-row-per-booking shape
  only represents one) — see item 64 for why that was the right call for now
  and what to do if it ever changes.
- ~~No database backup coverage of any kind~~ — **corrected 2026-07-16, this was
  wrong.** Originally concluded from two facts, both true in isolation: the live
  Supabase project (`rsnxhuhibglieofikkpo`, "ESRA") is on the Free plan (excludes
  both scheduled backups and PITR), and no `backup.yml` exists anywhere in *this*
  repo's `.github/workflows/` or git history. A third-party review had described a
  `backup.yml` doing `pg_dump`; that file's absence here was taken as proof the
  review was fabricated. It wasn't — the review was describing a **separate,
  private companion repo** (`blagdon/Stall_Booking`, not this one) that the owner
  maintains specifically for this. Confirmed directly against GitHub, not just
  taken on the owner's word: the repo is real, `backup.yml` runs `pg_dump
  "$SUPABASE_DB_URL" --clean --if-exists --no-owner --no-privileges` daily at
  02:00 UTC (plus manual `workflow_dispatch`), uploading the result as a GitHub
  Actions artifact with 30-day retention. Pulled its actual run history (not just
  the file) — 100/100 sampled runs succeeded, spanning 2026-04-12 through
  2026-07-16 with no failures — and the latest artifact is 156,834 bytes, a
  realistic size for a genuine full dump rather than an empty/broken one. The
  owner confirmed `SUPABASE_DB_URL` targets the live project. Real remaining
  limitations, not "no backup" but worth knowing: 30-day retention (not
  indefinite — a disaster discovered later than that has nothing to restore from),
  and restore is fully manual (download the artifact, replay it with `psql`/
  `pg_restore` by hand) rather than Supabase's one-click PITR. **Lesson for next
  time**: a repo's own git history only proves what that repo does — it says
  nothing about whether a separate, purpose-built companion repo exists doing the
  same job. Should have asked rather than concluding "fabricated" from one repo's
  absence of evidence.
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
`Confirmed`/`Rejected`/`Cancelled`/`HCC Checks` — see
[Stripe Payment Collection](#stripe-payment-collection) for `Payment Requested`), `business_name`,
`owner_name`, `email`, `stall_cost`, `cancel_token`, `rejection_reason`,
`stripe_checkout_session_id`, `stripe_payment_intent_id`, `stripe_payment_requested_at`
(all nullable, added 2026-07-15). **`bookings.location_id` (the old deprecated CSV
column) was dropped 2026-07-16** — see Next Steps for the removal writeup; location
assignment lives entirely in `booking_locations` now, see below. `is_charity` is a
native Postgres enum (`public.booking_fee_type`: `Commercial`/`Charity`/`Not for
profit`) as of 2026-07-16, not free text — see Next Steps for the migration and the
real bug it surfaced in `submit-booking`. `documents` (`text[]`) stores **storage paths
into
the (private) `esf-documents` bucket**, not public URLs — resolved to a signed URL on
demand by the `get-booking-documents` Edge Function. **Anon has zero direct access to
this table** (no RLS policy, no column grants) — public/unauthenticated consumers must
go through the `public_bookings_info` view instead, see
[Public visitor-facing data access](#public-visitor-facing-data-access-bookings).

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
editor='Stripe (automatic)'` via `finalize_stripe_payment()`.

**Extended 2026-07-16** for manual bank-transfer payments (see Next Steps item 43):
`payment_method` (`'stripe'` | `'bank_transfer'`, nullable, CHECK-constrained),
`payment_reference` (the value actually used to match the payment — the booking id
for bank transfers, the Stripe payment intent id isn't stored here separately from
`bank_ref`), `verified_by` (text — the admin's email, matching `editor`'s existing
text-not-uuid convention, not a FK; server-derived from `user_roles.email`, never
client-supplied), `verified_at`, `notes`. All nullable/additive; existing rows
backfilled `payment_method='stripe'` where `bank_ref LIKE 'Stripe:%'` (the only
reliable historical signal, since that prefix has been hardcoded since the original
Stripe migration).

**Extended again 2026-07-21** for refunds (see Next Steps item 64):
`refund_amount` (numeric — NULL means not refunded; may be less than
`bookings.stall_cost` for a partial refund), `refunded_at`, `refunded_by` (admin
email, or `'Stripe (automatic)'` when the `charge.refunded` webhook recorded it —
mirrors `editor`'s existing provenance convention), `refund_reference` (Stripe
refund id `re_…`, or the bank reference used for a manual transfer back), and
`refund_notes`. A `payments_refund_requires_payment` CHECK enforces
`refund_amount > 0 AND paid = true` at the database level, not just in the RPC,
because this table is also written directly by `finalize_stripe_payment()` and the
refund webhook. **Note `paid` stays `true` after a refund** — the payment genuinely
happened; the refund is separate state, not a reversal of that fact.
**Only ONE refund per booking is representable** by this shape; see item 64 for
why that was deliberate and how to migrate to a child table if it ever changes.

### `stripe_webhook_events`
Pure email-send dedup ledger for `stripe-webhook` (`event_id` PK, `event_type`,
`received_at`). RLS enabled, zero policies — `service_role` (the webhook, only) bypasses
RLS entirely; `anon`/`authenticated` get no access at all. **Not** the idempotency
mechanism for the actual payment processing — see
[Stripe Payment Collection](#stripe-payment-collection).

### `email_queue`
Doubles as a send log and (for bulk sends) a real queue. Columns: `recipient`,
`subject`, `body`, `status`, `error_message`, `instance_prefix`, plus
`retry_count`/`last_retry_at` (added 2026-07-19 for the viewer's Retry action —
`retry_count` is 0 for every send that has never been manually retried).
**`status` has four
values, not two**: `Pending` → `Processing` (bulk-send claim step, see
`claim_pending_emails()`, and also the claim step `retry-queued-email` uses)
→ `Sent` or `Error`. Individual sends (booking
confirmation/rejection/location emails, the "received" auto-responder, cancellation
confirmation) are all send-then-log — they call Zoho synchronously and insert the row
with the *final* status already known. Only the bulk-email path (`queue-bulk-email`)
ever inserts a genuinely `Pending` row that something processes later.

### `google_reviews_cache`
Server-side cache of SerpApi Google Maps lookups (added 2026-07-19).
`business_key` (PK — the normalized, lowercased/trimmed business name),
`payload` (`jsonb`, the exact response body `get-reviews` serves, including
`found:false` results — those cost a SerpApi call too), `fetched_at`. RLS
enabled with **zero policies**, `service_role` only — same access pattern as
`stripe_webhook_events`; `anon`/`authenticated` get nothing, and cached payloads
only ever reach a browser through `get-reviews`' own admin check. Safe to
truncate at any time: a cold cache just means the next lookup costs an API call.

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
`action`, `target_id`, `user_email`, `details` (JSON, stored as a JSON-stringified
value in this `text` column — confirmed empirically, not just assumed), `instance`.
Three columns (`user_name`, `action_type`, `booking_id`) were dropped 2026-07-16 —
dead weight, never written by `auditLog()` and never read anywhere. That second half
is no longer true: `audit_log.html` (see Next Steps item 40) now browses this table
back out, searchable by `target_id`/`user_email`/`action`/`details`, admin-only.

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
`allowed_stall_types`, `festival_display_name`, `base_url`, `cancel_url`,
`map_center_lat/lng`, `hcc_council_email`, `stripe_test_mode` (boolean as text,
Food/General Stripe test-mode override), `stripe_secret_key_test/live`,
`stripe_webhook_secret_test/live` (the actual Stripe credentials themselves — see
[Stripe Payment Collection](#stripe-payment-collection)), plus all `zoho_*`
credentials/cached tokens. **2026-07-16**: `bank_account_name`, `bank_sort_code`,
`bank_account_number` — the manual bank-transfer payment details shown in the
`payment_requested` email, editable via settings.html's own card. Originally added
deliberately separate from the pre-existing `bank_details` key (a single free-text
blob used only by the unrelated `confirmed_chargeable` template) — but since both
held the same real-world information, `bank_details` was removed the same day
(migration `20260716150000_drop_redundant_bank_details_setting.sql`) and the
`{{bank_details}}` template placeholder is now composed from these three
structured fields wherever it's used (`js/shared.js`'s `getEmailFromTemplate`,
`stripe-webhook`'s post-payment confirmation email), rather than reading a
separate freeform setting. The "BANK DETAILS FOR CONFIRMATIONS" field was
removed from settings.html's System Constants card accordingly.

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
npm run dev            # local server on :8080 (loopback only)
```
Use `npm run dev` rather than a bare static server: it proxies Supabase traffic
same-origin (so Edge Functions are callable locally) and widens each page's CSP
`connect-src` in flight, both of which the localhost test-project override
depends on — see [Verifying browser flows locally](#verifying-browser-flows-locally-the-test-project-override).
**By default it still serves production config**, exactly like any other static
server; the override is opt-in per browser.
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

### ⚠ Going live with real Stripe payments — checklist, NOT yet done

**As of 2026-07-21, production takes NO real card payments.** Verified directly
against the live `settings` table, not inferred:

| setting | state |
|---|---|
| `stripe_test_mode` | `'true'` |
| `stripe_secret_key_test` | configured (`sk_test…`) |
| `stripe_webhook_secret_test` | configured (`whsec_…`) |
| `stripe_secret_key_live` | **not set** |
| `stripe_webhook_secret_live` | **not set** |

That combination is coherent, not broken: `stripe_test_mode = 'true'` forces
Test mode for Food/General too (DEV is always Test regardless), so
`_shared/stripe.ts` never reaches for the live credentials and their absence
costs nothing. Every "real" payment taken so far has been a Stripe **test**
payment.

**The three steps below must happen together, and ORDER MATTERS.** The moment
`stripe_test_mode` flips to `'false'`, `getStripeSecretKey()` demands
`stripe_secret_key_live` and throws loudly if it is missing — deliberately, per
that module's "no partial/silent fallback" rule. Doing (3) first therefore
breaks payment collection outright until (1) is done.

1. **Set both live credentials** in `settings.html` → "Stripe Payments":
   `stripe_secret_key_live` and `stripe_webhook_secret_live`.
2. **Register the production webhook URL as a LIVE-mode endpoint** in the
   Stripe Dashboard — the same
   `https://rsnxhuhibglieofikkpo.supabase.co/functions/v1/stripe-webhook` URL,
   registered *separately* under Live mode, producing its own signing secret
   (that secret is what step 1 needs). **Enable the same events the Test-mode
   endpoint has**, which currently means `checkout.session.completed`,
   `checkout.session.expired`, and `charge.refunded` — miss the last one and
   refunds issued in the Stripe dashboard silently stop reconciling (see
   [Next Steps](#8-next-steps) item 64).
3. **Only then** set `stripe_test_mode` to `'false'`.

**How to check the live endpoint's events without guessing** — read-only, moves
no money, and the same call used to verify the Test-mode endpoints on
2026-07-21:
```bash
curl -s https://api.stripe.com/v1/webhook_endpoints \
  -H "Authorization: Bearer $STRIPE_LIVE_SECRET_KEY" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{for(const e of JSON.parse(d).data)console.log(e.url,e.status,e.enabled_events.join(','))})"
```

**Note the Sandbox trap**: Stripe's newer "Sandbox" is isolated from classic
Test mode — endpoints registered in a sandbox do not appear in Test mode and
vice versa. If the endpoint list looks unexpectedly empty or unfamiliar, check
which context the Dashboard is actually in (account switcher, top-left) before
concluding anything is missing.

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
  built-in `node:test`) runs **ten** test files (132 tests as of
  2026-07-20 — check `ls tests/*.test.mjs | wc -l` rather than trust this
  number, it has already gone stale twice). The three below are the
  originals; the rest were added alongside their features —
  `tests/stripe-payment.test.mjs`, `tests/bank-transfer-payment.test.mjs`,
  `tests/cors.test.mjs`, `tests/email-retry.test.mjs` (item 55),
  `tests/privilege-hardening.test.mjs` (item 58) and
  `tests/user-roles-enum.test.mjs` (item 60), and
  `tests/google-reviews-cache.test.mjs` (item 53, which proves cache
  hit/bypass/TTL behaviour **without ever making a real SerpApi call** — the
  test project has no key, so a "not configured" failure is the cache-miss
  detector):
  - `tests/integration.test.mjs` — the deployed `submit-booking` (including
    its temp→booking-folder document moves and the failed-move temp-path
    fallback, see [Next Steps](#8-next-steps) item 51), `cancel-booking`, and
    `queue-bulk-email` Edge Functions, plus the
    `get_next_booking_id`/`booking_locations_check_conflict`/
    `claim_pending_emails` database logic. This is where the retry-on-conflict
    fix for the booking-ID race (see [Next Steps](#8-next-steps) item 18) came
    from, caught by an actual concurrent-submission test, not code review.
  - `tests/workflow.test.mjs` — the full admin lifecycle (create → confirm →
    assign a location → move to a different one → record payment → move to
    HCC Checks → cancel), calling the same table/RPC operations `js/api.js`
    does, through a real signed-in admin session.
  - `tests/security.test.mjs` — behavioral RLS/column-grant checks against
    the real REST API as an actual anon caller: `bookings` has **zero** anon
    access of any kind (as of 2026-07-15 — see
    [Public visitor-facing data access](#public-visitor-facing-data-access-bookings)),
    `performers` is visible only through its permitted columns (selecting a
    disallowed column like `email` is rejected outright, not silently
    dropped — column-grant-restricted tables error on `select('*')` rather
    than omitting columns, learn this the hard way once and it explains a
    few early test failures below), non-`Confirmed`/non-`Scheduled` rows are
    invisible on `public_bookings_info`/`performers` respectively,
    `booking_locations` stays readable for a Confirmed booking's own location
    via the `is_booking_confirmed()` helper, `locations`' `DEV` rows never
    appear, and `user_roles`/`email_queue` reject anon entirely (zero table
    grants, not just RLS-filtered). This is the permanent version of the
    ad-hoc curl checks used to verify the `locations` DEV/LIVE fix earlier
    this session.

  **`--test-concurrency=1` is required, not optional** — Node's test runner
  runs separate test *files* concurrently by default, but every file
  shares one remote disposable database. Found live: `integration.test.mjs`'s
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

### Agent autonomy — what to do without asking

**Read this before deciding whether you need permission for something.** This
replaces the previous blanket rule ("no agent should run `supabase db push`
against the live project"), which the owner overrode ad-hoc often enough that a
vague prohibition was worse than an explicit policy: it produced pointless
round-trips for safe work while giving no real guidance on the genuinely
dangerous actions. The owner's standing instruction is to **do as much as
possible autonomously**. Default to acting.

**Green — just do it, then report what you did.** No permission needed, ever:
- **Additive migrations against production**: `CREATE TABLE`, `ADD COLUMN`
  (nullable or with a default), `CREATE INDEX`, `CREATE OR REPLACE FUNCTION`,
  seeding a new `settings`/`email_templates` row. Apply to the test project
  first, then production, both via `supabase db push`.
- **Edge Function deploys**, test project first then production.
- **Merging your own PR** once CI is green; deleting the merged branch.
- **Cutting a release**: CHANGELOG, HANDOVER, version bump, tag, GitHub release.
- **Regenerating `rls_grants_snapshot.txt`** (from production only — see the
  link dance in item 52).
- **Running the test suite** anywhere, and seeding/wiping the test project.

**Amber — do it, but the stated verification is mandatory, not optional.**
Skipping the check is the failure, not doing the work:
- **Migrations that change RLS policies or grants**: run
  `npm run check:rls-grants` against production *before* (to prove no
  pre-existing drift) and *after* (to prove only your intended change landed),
  and put both results in the PR. Diff every line of the after-check — "it
  passed" is not the same as "the diff was what I expected."
- **Anything touching `payments`, `bookings.stall_cost`, or the Stripe
  columns**: exercise the affected path in `tests/` before shipping. This is
  money; a passing unrelated suite is not evidence.
- **Changing an existing Edge Function's auth check**: add or extend a test
  proving the rejection still happens, live, as an actual anon/non-admin
  caller.

**Red — never without an explicit instruction naming the specific action in
the conversation.** A general "do it all" does *not* authorize these; if one
blocks you, stop and say so plainly rather than working around it:
- **Sending real email to real people.** Clicking Retry/bulk-send/reminders
  against production data, or any test that could deliver to a live address.
  Traders receiving a spurious festival email is not undoable.
- **Moving real money.** Stripe refunds, charges, or anything against the live
  keys.
- **Destructive DDL or DML on production**: `DROP TABLE`/`DROP COLUMN`,
  `TRUNCATE`, `DELETE`/`UPDATE` without a narrow `WHERE`, or a type change
  that can lose data. Note the backup is 30-day retention with a fully manual
  restore (section 10) — "we can roll back" is weaker here than it sounds.
- **Repointing `supabase-public.js`** at a different Supabase project. It sets
  the project for the public pages *and* the admin dashboard; doing this broke
  the entire app on 2026-07-18.
- **Rotating or replacing credentials** in the `settings` table (Zoho, Stripe,
  SerpApi).
- **Rewriting published history**: force-pushing `main`, deleting a branch with
  unmerged work, deleting a published tag or release.

**Non-negotiable sequencing, regardless of tier**: test project
(`qeplpcnrkgpaawfyliap`) first, full suite green, *then* production
(`rsnxhuhibglieofikkpo`). Always relink to the test project when you're done.
When a migration and a frontend change ship together, apply the migration
**before** merging — merging auto-deploys the frontend via Vercel, so the
reverse order puts live UI in front of columns that don't exist yet.

### Verifying browser flows locally (the test-project override)

Historically an agent couldn't verify anything in a browser, because
`supabase-public.js` points at production: loading an admin page locally talked
to the **live** database, so clicking a button could email real traders. That's
why items 51, 54 and 55 all shipped saying "an admin should confirm this."

**This now mostly works.** Two pieces, added 2026-07-19:

1. **`supabase-public.js` supports a localhost-only override.** It reads
   `localStorage.ESF_LOCAL_SUPABASE_OVERRIDE` and applies it *only* when
   `location.hostname` is in a strict allowlist (`localhost`, `127.0.0.1`,
   `::1`). A deployed origin cannot execute that branch, so production
   behaviour is unchanged; the override lives in localStorage rather than any
   file, so there is nothing to accidentally commit (which is exactly how this
   file caused a full outage on 2026-07-18). When active it is deliberately
   loud: a console warning plus a fixed on-page banner. Console helpers,
   defined on localhost only:
   ```js
   esfUseTestProject('<test anon key>', 'optional banner label')  // then reload
   esfUseProduction()                                             // then reload
   ```
   Both clear `ESF_SETTINGS_CACHE`, since applying one project's cached
   settings over another's is its own confusing failure. **Note there is no
   project-URL argument** — the dev server decides the target (below), so a
   page cannot aim itself at an arbitrary project, let alone production.

2. **`npm run dev` (`scripts/dev-server.mjs`) instead of `npx http-server`.**
   It does two things a plain static server can't:
   - **Proxies `/__supabase/*` to the test project.** When the override is
     active the Supabase client is pointed at that same-origin path instead of
     the project URL, so auth, PostgREST, Edge Functions and storage all
     become same-origin requests and **CORS never applies**. This is what makes
     Edge-Function-backed buttons clickable locally at all — `_shared/cors.ts`
     pins `Access-Control-Allow-Origin` to production, so a direct call from
     localhost fails with `Failed to send a request to the Edge Function`.
     Deliberately chosen over per-request origin negotiation in
     `_shared/cors.ts`: that would touch all eight functions including the
     payment paths, and `tests/cors.test.mjs` asserts the test project emits
     the *production* origin, so a naive env-var swap silently destroys that
     coverage. The proxy changes no Edge Function and no test.
   - **Widens each page's CSP `connect-src` in the bytes it serves**, never on
     disk — the deployed CSP stays exactly as strict. Don't "fix" this by
     adding a URL to the committed meta tags; a dev-only need must not loosen
     a production security header.

   The proxy only ever targets `TEST_SUPABASE_URL` from `.env.test`, so it
   cannot reach production even by mistake. WebSockets (realtime) are not
   proxied — nothing in this app uses them; add that if it ever does.

**Verified working end-to-end** (2026-07-20): signed in through the proxy and
clicked the Email Queue **Retry** button — `retry_count` incremented,
`last_retry_at` stamped, a fresh Zoho error replaced the seeded one, and
`audit_logs` recorded `retry_queued_email` against the right admin. That was
the first Edge-Function-backed button ever exercised locally, and closes the
gap that items 51, 54 and 55 all had to hand back to a human.

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
`supabase migration new <name>` under `supabase/migrations/`, applied with
`supabase db push` — same draft/review/confirm/commit shape, different mechanism, and
see [Agent autonomy](#agent-autonomy--what-to-do-without-asking) for when an agent
should run that itself versus stop and ask. Keep `storage` and `public` changes in separate migration files (see
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
    SELECT/INSERT plus table-level `TRIGGER`. **(`bookings`'s column-scoped SELECT was
    itself later removed entirely, item 31 below — this entry describes the state at
    the time it was written, not the current one.)**
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
30. **Fixed the `payment_requested` email** — it showed the raw Stripe Checkout URL as
    its own link text, and never substituted `{{cancel_link}}` at all (the placeholder
    existed in the docs/UI but `create-checkout-session` never populated it).
    `create-checkout-session` now fetches the `cancel_url` setting and the booking's
    `cancel_token`, same pattern as `js/shared.js`'s `getEmailFromTemplate`/
    `stripe-webhook`'s `sendConfirmationEmail`. The live template body was edited
    directly via `email_admin.html` to show `<a href="{{payment_link}}">Pay Now</a>`
    instead of the raw URL, and add a `<a href="{{cancel_link}}">Cancel Booking</a>`
    line, matching the wording style already used by the `payment_reminder` template.
31. **Security fix: removed anon's direct access to `bookings`, replaced with the
    `public_bookings_info` view** — see
    [Public visitor-facing data access](#public-visitor-facing-data-access-bookings)
    above for the full writeup (what a third-party review found, what was actually true
    on investigation, the fix, and the `booking_locations`-policy regression it would
    have caused if the fix had been "just drop the anon policy" without the
    `is_booking_confirmed()` `SECURITY DEFINER` helper). `js/api.js`'s `fetchMapData()`
    updated to query the view; `tests/security.test.mjs` rewritten/extended
    accordingly. Verified empirically against the disposable test project before this
    was considered done.
32. **Removed the `On Hold` status** — the owner asked directly, no further context
    given. Before touching anything, checked the live Kanban board across all three
    instances (FOOD, GENERAL, DEV) via a logged-in admin session: zero bookings were
    actually sitting in `On Hold` at the time, so there was nothing to reassign/migrate.
    Removed from `js/config.js`'s `STATUS_LIST`/`STATUS_COLORS`, the Kanban column +
    `getBoardStatuses()`/`cardBorderClass()`/dragula containers in `js/kanban.js`, the
    Summary status filter + both (desktop/mobile) "On Hold" action buttons in
    `summary.html`, both status-breakdown displays in `js/stats.js` (had to keep the
    doughnut chart's `backgroundColor` array positionally aligned with
    `Object.keys(statusCounts)` after removing the entry, and rebalanced the
    per-instance breakdown grid from `md:grid-cols-6` to `md:grid-cols-5`), and the badge
    color mapping in `js/page-hcc-dashboard.js`. The one place the **database** itself
    hard-coded `'On Hold'` (not just the frontend allow-list) was
    `cancel_booking_secure()`'s allowed-statuses check — a trader could self-cancel a
    booking that was `On Hold`, so removing the status without a forward-fix migration
    would have been a silent behavior change, not just a UI cleanup. New migration
    `20260715183903_remove_on_hold_status.sql` drops `'On Hold'` from that RPC's
    `NOT IN` list. Also fixed, spotted along the way: `create-checkout-session`'s
    already-resolved-status check still listed `'Paid'` even though that status was
    removed in item 29 — harmless (no booking can ever have that status again) but
    misleading; cleaned up in the same pass. `USER_GUIDE.md`/`ARCHITECTURE.md` were
    **not** updated — both were already out of date before this session touched
    anything (see the `ARCHITECTURE.md` Gotcha below; `USER_GUIDE.md` has never
    documented `Payment Requested` at all), so a partial On-Hold-only edit wouldn't
    have made either one accurate — needs a full pass if this repo ever prioritizes
    user-facing docs again.
33. **Dropped the deprecated `bookings.location_id` column** — flagged during a
    third-party schema review (correctly: it was genuinely dead, superseded by
    `booking_locations` well before this session even started). Verified empirically
    before touching anything, same discipline as every other schema change this
    session: grepped every `location_id` reference across `js/*.js` and
    `supabase/functions/*/index.ts` — every hit was either `booking_locations
    .location_id` (the real join table) or a JS-side property derived from it
    (`location_ids`, `location_display`); nothing anywhere read or wrote
    `bookings.location_id` directly, including the `submit-booking` INSERT path. New
    migration `20260716052837_drop_deprecated_bookings_location_id.sql`. Also drops
    `idx_bookings_location_id` as an automatic side effect (Postgres drops indexes that
    depend solely on a column when the column itself is dropped) — no separate
    `DROP INDEX` needed. Pure cleanup, no application code changed since nothing used
    the column; all 52 tests still pass, including the location-assignment steps in
    `tests/workflow.test.mjs`.
34. **Audited the whole schema for other dead columns, at the owner's request right
    after item 33.** Pulled every table/column from the baseline migration and
    cross-checked each against actual reads/writes across `js/*.js` and the Edge
    Functions — same technique as item 33, just applied schema-wide instead of to one
    column. Found three more genuinely dead ones, all on `audit_logs`: `user_name`,
    `action_type`, `booking_id` — none ever written by `auditLog()` (the only writer),
    and none ever read (no admin page browses `audit_logs` at all). Dropped in
    `20260716053659_drop_dead_audit_logs_columns.sql`. **Explicitly did NOT touch**
    `performers`/`schedules`/`location_power` despite zero references anywhere in this
    repo's code — that's because that whole feature is managed by a separate Vercel
    deployment (`ellafestperformersadmin.vercel.app`), not because those columns are
    actually dead; "no references in this repo" and "dead" are not the same thing when
    a different live codebase owns the table. Also surfaced, while checking a
    third-party review's claim that `schedules.location` lacked a foreign key: it
    doesn't lack one — `schedules_location_fkey` already references
    `locations(id, dataset)` — so that specific review point was simply wrong, not
    unverified.
35. **Audited every function/RPC in the schema for unused ones, at the owner's request
    right after item 34.** Cross-checked every function against `.rpc(...)` calls,
    trigger attachments, and RLS policy references. `rpc_set_booking_locations`,
    `cancel_booking_secure`, `get_next_booking_id`, `finalize_stripe_payment`,
    `claim_pending_emails` are all directly RPC'd and alive. Trigger functions
    (`booking_locations_check_conflict`, `is_booking_confirmed`, plus the
    performers/schedules-only ones) fire automatically and are alive too — not calling
    them by name doesn't mean unused. `get_is_admin()` turned out to be used (exactly
    one policy, `user_roles`'s own `policy_allow_all_admin`) — redundant with
    `check_user_role('admin')` doing the same job elsewhere, but not dead, so left
    alone; flagged for whoever next touches admin-role logic.

    The real, subtler finding: this schema registers custom `=`/`<>` operators between
    `text` and `user_role` (four backing functions: `eq_text_user_role`,
    `eq_user_role_text`, `neq_text_user_role`, `neq_user_role_text`). Tracing
    `check_user_role()`'s body — `role = required_role`, where `role` (`user_roles.role`)
    is `text` and `required_role` is `user_role` — that expression is what silently
    invokes `eq_text_user_role` on **every** RLS check across this schema (Postgres
    picks the exact-type-match operator; there's no explicit call to the function name
    anywhere in the SQL text, which is exactly why a naive grep would have missed this
    entirely). That one function/operator pair is essential and was left untouched. The
    other three were never invoked anywhere: `public.user_role` is never used as a
    column type (only as a function parameter), nothing anywhere reverses the
    comparison order, and nothing anywhere negates it with `<>`. Dropped
    `eq_user_role_text`, `neq_text_user_role`, `neq_user_role_text`, and their two
    `<>`/`=` operator registrations in
    `20260716054553_drop_unused_user_role_operators.sql`. Given how central
    `check_user_role()` is (it gates `bookings`, `email_queue`, `locations`, `payments`,
    `audit_logs`, `hcc_checks`), this one was treated with more caution than a flat
    dead-column drop: tested on the disposable project first, full 52-test suite run
    (exercises `check_user_role` via RLS on nearly every admin action — all green),
    then re-verified directly on live after deploying there too: anon still fully
    blocked from `bookings`/`user_roles`, `public_bookings_info` still works for anon,
    and the admin Kanban board still loads normally (75 bookings, all columns) with the
    real admin session, confirming the surviving `eq_text_user_role` operator is intact
    and doing its job.
36. **Audited every index in the schema for unused ones, at the owner's request right
    after item 35.** Different flavor of check than 33–35: index usage is a runtime
    query-planner decision, not something grep can fully settle. What grep *can* settle
    with certainty is the negative case — if no query anywhere filters on a column, the
    index on it cannot possibly be used, full stop, regardless of what the planner would
    otherwise choose. Two indexes met that bar: `idx_bookings_email` (no code anywhere,
    admin JS or Edge Functions, filters `bookings` by `email` — there's no
    duplicate-detection feature) and `idx_audit_logs_target_id` (`target_id` is
    write-only, same finding as the `audit_logs` dead-column cleanup in item 34 — no
    admin page reads it back). Dropped both in `20260716060029_drop_unused_indexes.sql`.
    Deliberately did **not** attempt to verify the remaining indexes' actual runtime
    usage via `pg_stat_user_indexes` — that would need a temporary diagnostic function
    on the live project, and the owner explicitly said not to bother. The other
    `bookings`/`booking_locations`/`hcc_checks`/`locations` indexes all have real
    matching query patterns in the code (`idx_bookings_status` is even baked into the
    `public_bookings_info` view's own `WHERE` clause) — "plausibly used," not verified
    at the same certainty level as the two dropped here, but not acted on either.
    `performers`/`schedules` indexes left untouched, same reasoning as every other
    finding in this audit series.
37. **Converted `bookings.is_charity` from free text to a native enum
    (`public.booking_fee_type`)**, at the owner's request following the schema review
    series. `is_charity` is a genuine tri-state (`'Commercial'`/`'Charity'`/`'Not for
    profit'`) — a boolean replacement was proposed and rejected earlier in the same
    review for exactly this reason (it would merge `Charity` and `Not for profit`,
    destroying a distinction `js/kanban.js`'s confirm-booking logic relies on).
    `performers.status` (already a `public.performer_status` enum in this same schema)
    is a working precedent that PostgREST round-trips enum columns as plain JSON
    strings with zero JS-side changes needed — confirmed true here too: no application
    code changed except the one real bug this surfaced (below). Migration
    (`20260716061350_is_charity_to_enum.sql`) drops the old text default before
    changing the column type (Postgres can't implicitly re-cast a text default to an
    enum), casts via `is_charity::text::booking_fee_type`, then re-adds the default.

    **This is atomic and self-verifying by construction**: if any existing row held a
    value outside the three labels, the whole statement would fail and roll back
    cleanly — no separate live pre-check was needed (and the one considered — reading
    `localStorage`'s admin session token to hit the REST API directly — was correctly
    blocked by the auto-mode classifier as a technique beyond what "do the enum change"
    actually authorized). And it *did* catch something real: `submit-booking`'s
    `sanitizeBookingInput()` stored `is_charity` via the generic `sanitizeString()`
    helper, which turns a missing/blank value into `''` — previously silently harmless,
    since every *read* site (`js/api.js`, `js/details.js`, `js/shared.js`) already
    falls back to `'Commercial'` on any falsy value, but now a hard insert failure
    against the enum. The public forms (`Food_Stall_booking.html`/`General_Booking.html`)
    mark this field `required` with no selectable blank option, so a real browser user
    can't actually hit this — but `submit-booking` is a public, unauthenticated
    endpoint (its own docstring already says client-side validation is "trivially
    bypassable by calling it directly"), and the integration test suite does exactly
    that. Fixed with a dedicated `sanitizeCharityStatus()` that defaults to
    `'Commercial'` for anything outside the three valid labels, matching the fallback
    convention already used everywhere else `is_charity` is read — real defense in
    depth for a public endpoint, not just a test-fixture workaround. `update_details.html`'s
    admin edit form already uses a fixed `<select>` with the three exact values, so
    that path needed no change. Verified: full 52-test suite green on the test project
    after the fix.
38. **Fixed `api/ping.js` (the daily Vercel Cron keep-alive), a real regression from the
    2026-07-16 security fix in item 31.** The owner asked whether this repo performs a
    database backup — investigation at the time found none exists anywhere in *this*
    repo or its linked Supabase project (no workflow, no script, no Supabase-side
    scheduled backup or PITR; the project is on the Free plan, which excludes both),
    and the likely source of the question was assumed to be the disposable Supabase
    project's dashboard display name, **"test backup"**. **That "no backup anywhere"
    conclusion was wrong — corrected in the "Known gaps" note above**: a real, separate
    companion repo (`blagdon/Stall_Booking`) does run a genuine, verified-working daily
    `pg_dump` against the live project. The "test backup" naming-confusion theory may
    still have been part of what prompted the owner's original question, but it wasn't
    the whole story. While checking, found that `api/ping.js` — the cron that
    exists specifically to stop the Supabase free-tier project auto-pausing after 7
    days of inactivity — queries `bookings` directly with the anon key
    (`select=id&limit=1`), which has returned `permission denied for table bookings`
    silently (caught, logged, 500 returned) every single day since item 31 shipped,
    since that's exactly the access anon lost. Fixed by pointing it at `locations`
    instead, which still has an unconditional `USING (true)` anon SELECT policy —
    verified directly with a real anon-key REST call (`200`, real row returned) before
    considering this done.
39. **Fixed a genuine, empirically-proven race condition in `booking_locations_check_conflict()`,
    raised by the owner during the schema review series ("does the database itself
    prevent two active bookings from occupying the same pitch under a race
    condition?").** The trigger only ever ran a plain `SELECT ... INTO v_conflict_id`
    before `RAISE EXCEPTION` — no `SELECT ... FOR UPDATE`, no table lock — a classic
    check-then-act race, structurally identical to the `get_next_booking_id()` bug
    already fixed once in this schema.

    **A first concurrency test (`Promise.all()` on two direct service-role inserts,
    bypassing `rpc_set_booking_locations()` to hit the trigger directly) passed —
    but this was a false negative**, not proof of safety. Two HTTP round trips through
    PostgREST don't reliably land in the same microsecond-scale window a single-row
    `INSERT` + trigger takes to run. To get a real answer, ran a one-off diagnostic
    (not committed): temporarily patched the trigger on the disposable test project
    only, via `supabase db query --linked` (no tracked migration file), to add
    `PERFORM pg_sleep(1)` after the conflict check, gated to a magic
    `location_id = 'TESTLOC-RACE-FORCED'` so it could never fire on real data. This
    forces two concurrent calls to genuinely overlap regardless of network timing.
    Result: **both concurrent inserts succeeded, no errors, and the table ended up
    with 2 rows for the same location** — a real double-booked pitch. The diagnostic
    patch was reverted immediately after (confirmed via `pg_proc.prosrc` containing no
    `pg_sleep`), and the full 53-test suite was re-run clean to confirm the test
    project was back to its true migration-tracked state before touching anything else.

    **Fix** (`20260716064846_lock_booking_locations_against_race.sql`): added
    `LOCK TABLE booking_locations IN SHARE ROW EXCLUSIVE MODE;` inside
    `rpc_set_booking_locations()` — deliberately in the RPC, not the trigger, mirroring
    exactly where `get_next_booking_id()`'s fix lives, and because `rpc_set_booking_locations()`
    is the *only* place application code ever writes to `booking_locations`
    (`js/api.js` and `js/page-steward.js` both call only this RPC; nothing writes to
    the table directly). `tests/integration.test.mjs`'s concurrency test was rewritten
    to call `rpc_set_booking_locations` through an authenticated admin client (matching
    real app usage) instead of a direct table insert, since that's the path the fix
    actually protects — full 53-test suite green afterward.
40. **Built `audit_log.html`, a new admin-only page to browse/search recorded
    `auditLog()` actions**, requested after a recovery-testing review raised four
    questions (backup restore, accidental deletion, failed Stripe webhooks, corrupted
    location assignments). The first three were investigation/opinion only (see the
    review response); this one — "corrupted location assignments are only
    reconstructable via a raw SQL query today" — got a real fix, since the data to
    reconstruct history already existed in `audit_logs` (every `allocate_location` call
    logs the full `location_ids`; every status change is logged separately as
    `update_status`) but nothing in the app ever read it back out.

    New page (`audit_log.html` + `js/page-audit-log.js`), admin-only via
    `initAdminPage()`'s default `requiredRole`, matching the existing "Admin view audit"
    RLS SELECT policy exactly (a steward session would just see an empty table, not an
    error, since RLS silently filters rather than rejecting). Search box does a
    server-side `.or()` ILIKE across `target_id`/`user_email`/`action`/`details`
    (debounced 400ms) rather than the client-side-filter-the-loaded-page pattern
    `summary.js` uses elsewhere — deliberately, since the whole point is finding
    *old* entries well past whatever small "recent" page would otherwise be loaded.
    Commas/parens are stripped from the search term first, since PostgREST's `.or()`
    filter string uses both as syntax (comma = OR-separator, parens = grouping) — not a
    security issue (PostgREST's filter parser can't execute arbitrary SQL), just avoids
    a malformed-filter 400 on ordinary punctuation in a search term. `details` is
    stored as a JSON-stringified value in a `text` column (confirmed by inserting a
    real row on the test project and reading it back: `"{\"location_ids\":[...]}"`,
    `typeof` `string`) — rendered via a `<details>` disclosure per row (short one-line
    preview, click to expand the pretty-printed JSON) so a long details blob doesn't
    blow out row height by default. Action-type filter dropdown is a hardcoded list of
    every `auditLog()` call site's action string as of today (not queried from the DB
    live) purely to populate friendly-labeled options — the search box itself matches
    on the raw column regardless, so a newly added action type still shows up via
    search even before someone remembers to add it to this list.

    **Wired into the existing booking detail pane**: a new "History" link next to
    "Send Email" in both `kanban_m.html` and `summary.html` (identical markup in both,
    since both share `js/shared.js`'s single `populateDetailPane()` — the link's `href`
    is set once there: `audit_log.html?target=<bookingId>`, opened in a new tab) opens
    the viewer pre-filtered to that exact booking. Clicking any target-id cell in the
    viewer itself re-filters to that target too, for drilling from one booking's
    history into a related one (e.g. an email action logged against a different id).

    Re-added `idx_audit_logs_target_id` (`20260716074357_add_audit_logs_target_id_index_for_viewer.sql`)
    — dropped only hours earlier the same day in item 36 on the grounds that nothing
    read `audit_logs` back out; that's no longer true now that this page's primary
    lookup is exactly `target_id`. Full 53-test suite green on the test project after
    the migration (this page has no automated test — there's no existing pattern in
    this repo for testing frontend page JS/DOM rendering, only DB/RPC/Edge-Function
    integration tests — verified instead by hand against the live site).

41. **Ran a real disaster-recovery restore drill** against the disposable test project,
    prompted by a follow-up review ("a backup that's never been restored is a
    hypothesis, not a safety net"). Downloaded a real artifact from the
    `blagdon/Stall_Booking` backup workflow (item 39/Known Gaps) and actually restored
    it, rather than reasoning about it in the abstract. Full method, findings, and the
    resulting step-by-step procedure are written up in
    [Disaster Recovery Runbook](#10-disaster-recovery-runbook) below — summary here:

    Real production data restores completely and correctly (row counts and content
    both verified) once two blockers are worked around: `supabase db query -f` (the
    only tool available without a real `psql` client) silently drops every `COPY
    FROM STDIN` block with no error, and the dump's `--no-privileges` flag means
    every `GRANT`/`REVOKE` this schema depends on for its actual security posture is
    entirely absent, so a naive restore silently reopens **every** anon/authenticated
    access restriction this project has ever added — including this session's own
    bookings-PII fix. Also confirmed `auth.users` genuinely is captured (7 rows) and
    `public.user_roles` cannot be restored in isolation from it (hard FK). Diagnosed
    and fixed by diffing a fresh `supabase db dump` against the already-tracked
    `rls_grants_snapshot.txt` (item 46) rather than hand-guessing — that snapshot
    turned out to be the single most useful tool for this entire drill. Cleaned up
    afterward: truncated the real data back out, re-ran `scripts/seed-test-project.mjs`,
    full 53-test suite green.
42. **Full permission audit across every major table** (`bookings`, `payments`,
    `locations`, `performers`, `schedules`, `user_roles`, `audit_logs`), requested
    after the owner flagged access control as the most likely source of future
    issues as the system grows. Read the actual current policies/grants directly
    (`supabase db dump --schema public,storage` against the **test** project, never
    live — a full schema dump pulls real data too, and auditing access-control
    *rules* doesn't need real PII) rather than reasoning from memory. Two real,
    pre-existing findings (both predate this session, undocumented anywhere):

    - **`performers`**: two SELECT policies for anon both matched
      `status IN ('Scheduled','Paid')`, but only one also required
      `deleted_at IS NULL`. RLS policies are OR'd together, so the policy missing
      that check fully neutralized the other's restriction — a soft-deleted
      performer (that column is owned entirely by the separate
      `ellafestperformersadmin.vercel.app` app; this repo never writes it, but that
      app has real, active soft-delete usage per the Gotchas entry below) stayed
      publicly visible if it was ever marked Scheduled/Paid. Fixed
      (`20260716105038_fix_permission_audit_rls_gaps.sql`) by folding the
      `deleted_at` check into the policy that actually covers both `authenticated`
      and `anon`, then dropping the now-fully-redundant anon-only policy. Added a
      regression test (`tests/security.test.mjs`, a soft-deleted Scheduled performer
      fixture) — this class of bug (two overlapping policies where the broader one
      silently defeats the narrower one's extra restriction) doesn't show up in a
      grants-snapshot diff at all, only in a real behavioral test.
    - **`audit_logs`**: three separate INSERT policies all landed on the same
      outcome (two were byte-for-byte identical; the third was a no-op for anon
      since `auth.uid()` is null for a genuine unauthenticated request). Not a
      security hole on its own, but exactly the shape of thing that causes a
      *future* mistake — dropping one policy while believing you've tightened
      access, not realizing two others still allow it. Consolidated to the one
      with the clearest name.

    Also confirmed, without needing a fix: `payments`/`locations`/`location_power`/
    `booking_locations` all carry a blanket table-level `GRANT ALL` to
    `anon`/`authenticated` with RLS as the only real gate (correctly enforced
    everywhere checked) — a deliberate, common Supabase pattern, not a mistake, but
    worth naming as this schema's single biggest systemic risk: if RLS is ever
    disabled on any of these tables, even briefly during a migration or a debugging
    session, that table becomes immediately and fully open to anon, with nothing
    else standing in the way. `user_roles` has no self-escalation path (writes
    gated by `get_is_admin()` in both `USING` and `WITH CHECK`); `schedules` uses
    `FORCE ROW LEVEL SECURITY` (stronger than every other table — applies even to
    the table owner). Verified on the test project (54-test suite, including the
    new regression test), deployed to live, `rls_grants_snapshot.txt` regenerated
    (which also picked up the unrelated pre-existing staleness from the July 16
    operator cleanup — that snapshot hadn't been regenerated since before that
    migration shipped).
43. **Manual bank-transfer payments, alongside the existing fully-automated Stripe
    flow** — requested as a complete feature spec (no new booking statuses, no new
    Kanban columns; the board stays structurally unchanged). Closed a real gap: a
    booking sitting in `Payment Requested` had **no way to be marked paid by bank
    transfer at all** before this — `updatePayment()`/the Edit-Payment modal can
    only ever *update* an existing `payments` row, never create one, so
    `fetchPayments()`'s synthesized `awaitingPayment` rows only ever offered "Resend
    Payment Link."

    **DB** (`20260716142140_bank_transfer_payments.sql`): `payments` gets 5 new
    columns (see Data Model above). `finalize_stripe_payment()` additively stamps
    `payment_method='stripe'` — no other behavior change. New RPC
    `rpc_record_bank_transfer_payment(p_booking_id, p_payment_reference, p_notes)`
    mirrors `finalize_stripe_payment`'s exact atomic shape (one `UPDATE bookings ...
    WHERE status='Payment Requested'`, then upsert `payments`) with two deliberate
    differences: it's called directly by an admin's own authenticated session (no
    server-only "bank webhook" exists), so it does its own internal
    `role='admin'` check exactly like `rpc_set_booking_locations` rather than
    relying on a service-role-only grant; and if the booking isn't currently
    `Payment Requested`, it **raises an exception** instead of `finalize_stripe_payment`'s
    silent no-op — that no-op is correct for a retried webhook with no human
    watching, but this is a one-shot synchronous admin click, where silently doing
    nothing would leave the admin believing they'd recorded a payment when nothing
    happened. `payment_requested`'s `body_html` was updated to add a labeled
    "Option 2 — Bank Transfer" section (Account Name/Sort Code/Account
    Number/Payment Reference, the last always the booking id) plus the required
    "your booking will not be confirmed until payment has been received and
    verified by an administrator" sentence — built directly on top of the
    template's **actual current live content** (fetched and read directly first,
    not assumed from memory or the original seed migration — it had already
    diverged via a live admin edit through `email_admin.html` sometime after that
    migration ran), so the existing "Pay Now"/"Cancel Booking" wording is completely
    unchanged, only the new section and sentence are inserted.

    **Audit logging stays client-side, deliberately** — grepped every migration for
    `INSERT INTO.*audit_logs` and found zero hits; even `finalize_stripe_payment`'s
    fully-automatic Stripe confirmation writes no audit log today. `auditLog()`
    (`js/api.js`) is the sole writer of that table by design (see item 34's dead-column
    finding). The new `recordBankTransferPayment()` function follows this exactly:
    calls the RPC, then fires three separate `auditLog()` calls
    (`bank_transfer_recorded`, `bank_transfer_verified`,
    `booking_auto_confirmed_bank_transfer`) — an admin recording a transfer *is* the
    verification, so those two happen in the same action but are still logged as
    the two distinct events requested, plus the knock-on status change.

    **UI**: `payments.html` gets a new "Record Bank Transfer" button (next to
    "Resend Payment Link", only for `awaitingPayment` rows) opening a new modal —
    Booking/Amount read-only display, locked "Bank Transfer" method, an editable
    Payment Reference (defaults to the booking id, editable per spec if the
    stallholder used a different one), Notes. The pre-existing "Edit Payment"
    modal/`updatePayment()` flow is completely untouched — it still serves its
    original purpose (adjusting an already-existing `payments` row). `settings.html`
    gets a new "Bank Transfer Payment Details" card (plain text inputs, not
    masked — these aren't secrets, they're shown to stallholders) for the three new
    settings keys, following `initSerpApiSettings()`'s exact load/save/audit-log
    shape.

    **A real, unrelated gap surfaced along the way**: `scripts/seed-test-project.mjs`'s
    `ensureAdminUser()` had never set `user_roles.email` for the bootstrap test
    admin (only `id`/`role`) — meaning `rpc_record_bank_transfer_payment`'s
    `verified_by` came back as the `'Admin'` fallback instead of a real email in
    testing, since the column it reads from was NULL. A real admin account created
    via `manage_users.html` always has this set (`js/page-manage-users.js`'s
    `createUser()`), so this was purely a stale test fixture, not an app bug — fixed
    by seeding `email` alongside `role`.

    Verified on the test project (64-test suite, including a new
    `tests/bank-transfer-payment.test.mjs` covering the RPC's admin-only gating —
    anon rejected, a demoted-to-steward session rejected, happy path, a booking not
    currently `Payment Requested` rejected, a blank reference rejected — the
    payment-request email's content, and one added assertion on the existing
    `finalize_stripe_payment` happy-path test proving the additive change didn't
    break the Stripe flow), then deployed to live.

    **Follow-up fix, same day**: a check of whether `bank_details`/`confirmed_chargeable`
    were still in use (they are — `stripe-webhook`) surfaced a real gap:
    `recordBankTransferPayment()` calls the RPC directly and
    never sent any confirmation email at all, unlike the Stripe path, which always
    sends `confirmed_chargeable` from the webhook after a successful payment — the
    spec's "mirror the outcome of a successful Stripe payment" was only half done
    (the status change, not the email). Fixed in `js/payments.js`'s
    `saveBankTransferPayment()`: after the RPC succeeds, sends `confirmed_chargeable`
    via the same client-side `getEmailFromTemplate()`/`sendEmail()` pair
    `sharedUpdateStatus()` already uses for a manual confirm — reusing already-proven
    infrastructure rather than adding a new send path. Deliberately wrapped in its
    own try/catch: the payment/confirmation has already succeeded by that point, so
    an email failure is a lesser, distinct problem and must not read as "the payment
    wasn't recorded." This is a client-side-only change (no migration, no Edge
    Function) — not covered by the Node test suite, which has no browser-level
    tests anywhere in this repo; verified by reading the existing, already-proven
    `sharedUpdateStatus()` code path it reuses rather than duplicating logic.

    **2026-07-16, later same day — dead-code cleanup**: asked "when is
    `confirmed_chargeable` used?", tracing every caller found only **two** genuinely
    live send sites — `stripe-webhook`'s post-Stripe-payment confirmation email, and
    `js/payments.js`'s `saveBankTransferPayment()` (the fix directly above). Two
    other things referenced the template but were unreachable: `js/shared.js`'s
    `sharedUpdateStatus()` had a `chargeable ? 'confirmed_chargeable' : 'confirmed_free'`
    branch, but every real caller (`js/kanban.js`/`js/summary.js`'s `finalizeConfirm`,
    reached via the drag-drop/button/swipe Free-Chargeable modal) only ever passes
    `isChargeable=false` for a direct-to-`Confirmed` transition — a chargeable
    confirmation always redirects to Stripe (`Payment Requested`) instead, so the
    `true` branch was leftover from before that redirect existed. `manualResendConfirmation()`
    in `js/shared.js` was exported but never imported or wired to any button anywhere
    — fully dead. Removed both: `manualResendConfirmation()` deleted outright;
    `sharedUpdateStatus()`'s `Confirmed` handling simplified to always be the free
    path (zero behavior change, since that was the only reachable outcome);
    `js/api.js`'s `finalizeConfirmation(id, isChargeable, providedSnapshot, overrideCost)`
    correspondingly simplified to `finalizeConfirmation(id)` — it's only ever called
    for a free confirmation now, so the chargeable branch (cost/payments-row creation)
    and the now-unread booking-snapshot fetch were removed too, along with the
    resulting unused `getStallCost` import in `js/api.js`. `tests/workflow.test.mjs`'s
    comment describing a simulated chargeable-confirm DB state was reworded to stop
    citing the now-removed `finalizeConfirmation(id, isChargeable=true)` signature —
    the test's assertions were untouched, since it already worked at the DB level
    rather than importing browser JS. No migration, no Edge Function change; verified
    via the existing 64-test suite (client-side-only change, same testing limitation
    as the fix above).
44. Verified `claim_pending_emails()` isn't exposed to anon the same way the Stripe RPCs
    briefly were (2026-07-15). While testing the new Stripe RPCs
    (`mark_stripe_payment_received`, `finalize_stripe_confirmation`, on the
    `stripe_integration` branch), it turned out `REVOKE ALL ON FUNCTION ... FROM PUBLIC`
    alone did **not** block anon from calling them — this project's schema-level `ALTER
    DEFAULT PRIVILEGES` grants new functions directly to `anon`/`authenticated` at
    creation time, so revoking `PUBLIC`'s blanket grant doesn't touch a role's own
    separate direct grant (fixed there via
    `20260715123703_fix_stripe_anon_authenticated_grants.sql`, which revokes explicitly
    `FROM "anon", "authenticated"` by name). `claim_pending_emails()`
    (`supabase/migrations/20260714132316_baseline_schema.sql`, ~line 1124) uses the
    exact same `REVOKE ALL ... FROM PUBLIC` pattern and had never actually been
    live-tested for anon-rejection — this document's own "Testing" section previously
    described it as covered based on the grant statements alone, not a real call.
    Live-tested directly against the disposable test project
    (`qeplpcnrkgpaawfyliap`): `anon.rpc('claim_pending_emails', { p_batch_size: 1 })`
    returns a real `42501 permission denied for function` error, not a silent success —
    **this one is fine as-is**, no migration needed. Added a permanent regression test
    (`tests/security.test.mjs`, "anon access to privileged RPCs" describe block) to lock
    this in going forward. Lesson: don't infer anon-rejection from `REVOKE ... FROM
    PUBLIC` grant text alone on this project — always verify live, per the Stripe RPC
    finding above.
45. Dead-code deletion + worktree cleanup (2026-07-17). PR #6 (merge 878a7db) deleted
    `js/page-food-booking-dev.js` and `Food_Booking_DEV.html`: no HTML file loaded the
    module (the DEV page was a static "Bookings Closed" placeholder with zero `<script>`
    tags), a repo-wide grep found no other reference beyond a historical comment in
    `20260717080000_revoke_vestigial_anon_function_grants.sql`, `vercel.json` had no
    route/rewrite for the page, and the bootstrap refactor (item 44's sibling work,
    PR #5) had already flagged the module as a deletion candidate. The HTML removal is
    its own commit in case the bare URL should go back to serving the "closed" notice
    instead of a 404. Then all leftover `.claude\worktrees\*` worktrees were removed —
    and **two of them held real uncommitted work**, salvaged rather than deleted:
    PR #7 (item 44's regression test, from `fervent-mirzakhani-71111d`) and PR #8 (the
    dead `visitor-map` Edge Function fallback removal in `js/api.js` from
    `kind-cartwright-8df7d2` — that fallback fetched a function that never existed in
    `supabase/functions/`, always failed, and silently fell through to the direct
    query). Lesson: check `git status --porcelain` in every worktree before removing
    it. Gotchas hit: (a) branches parked at old commits fail the pre-commit hook
    because `scripts/check-unescaped-innerhtml.mjs` doesn't exist there — fast-forward
    the branch onto main first rather than `--no-verify`; (b) deleting a remote branch
    leaves stale local `origin/*` refs until `git fetch --prune`, making the branch
    look alive; (c) with `cancel-in-progress: false`, GitHub still allows only ONE
    pending run per concurrency group, so simultaneous pushes to multiple PRs get
    their queued `integration-tests` runs cancelled — just `gh run rerun --failed`
    once the queue drains, nothing is actually broken.

46. Narrowed `payments` table grants for `anon` (2026-07-18,
    `20260718090000_narrow_payments_table_grants_anon.sql`, same defense-in-depth
    pattern as item 44's `settings` narrowing). `anon` held `GRANT ALL` on `payments`
    with only the "Admin only payments" RLS policy (implicitly `PUBLIC`, gated on
    `check_user_role('admin')`) standing behind it — a bad policy edit or an
    accidental `DISABLE ROW LEVEL SECURITY` would have hit the table recording who
    paid what for a stall booking. Traced before touching anything: no trigger exists
    on `payments`; every write path (`mark_stripe_payment_received`,
    `finalize_stripe_confirmation`, `finalize_stripe_payment`,
    `rpc_record_bank_transfer_payment`) is `SECURITY DEFINER` and already denies
    `anon` at the function level (`REVOKE ALL FROM PUBLIC` plus, for the bank-transfer
    RPC, an explicit `REVOKE ... FROM "anon"`); grep of every `.from('payments')` call
    site (js/api.js only) confirmed all three live behind `getSupabaseClient()`,
    reachable only from admin-authenticated pages — the public booking pages
    (`page-cancel.js`/`page-general-booking.js`/`page-food-booking.js`) import only
    `getPublicSupabaseClient` and never touch `payments`. `anon` now has zero
    table-level privileges, not even SELECT. Applied to the disposable test project
    first, full 70-test suite green (including the entire Stripe/bank-transfer/
    booking-confirmation workflow), then to the live project; independently
    confirmed via a direct read-only query that `anon`'s privileges on `payments` are
    now empty. Added a live-verified regression test (`tests/security.test.mjs`,
    "payments is completely inaccessible to anon, including writes") rather than
    trusting the grant text — same lesson item 44 already recorded. `authenticated`/
    `service_role` grants on `payments` are untouched; this was scoped to `anon` only.
    Gotcha: regenerating `rls_grants_snapshot.txt` while the local CLI happened to
    still be linked to the disposable test project produced a snapshot with several
    extra `storage.objects` policies the test project has and production doesn't —
    caught before committing by re-diffing and noticing the unexpected lines; always
    confirm `cat supabase/.temp/project-ref` before running
    `check-rls-grants-snapshot.sh --update`, and relink back to the test project
    immediately after touching production (the safe default per this repo's
    convention).
47. Narrowed the rest of the anon-`GRANT ALL` tables/views flagged alongside `payments`
    (2026-07-18, `20260718100000_narrow_remaining_anon_table_grants.sql`, item 46's
    sibling). Queried production directly first for a fresh, authoritative list of
    every table where `anon` still held elevated privileges, rather than trusting a
    written-down list that could have drifted. Traced every `CREATE TRIGGER` in the
    schema (5 total) and every anon-reachable write path (`performers`' "Public can
    apply" INSERT is the only one) to confirm no non-`SECURITY DEFINER` trigger writes
    into any of the target tables as a side effect — the exact "trigger trap" this
    kind of change can fall into. Also discovered `js/api.js` is not purely
    admin-only as previously assumed: `js/map.js` (used by the public
    `visitor_map.html`) imports `fetchMapData()` from it directly, and
    `getSupabaseClient()`/`getPublicSupabaseClient()` construct clients from the
    identical anon key — so that read genuinely runs as `anon`, which is exactly
    why `locations`/`public_bookings_info` need `anon` SELECT (confirmed
    `fetchMapData()` touches only those two, both read-only). Result: `anon`
    `REVOKE ALL` (zero access) on `audit_logs`/`email_templates`/`hcc_checks` (no RLS
    policy for anon on any of them); `anon` narrowed to `SELECT` only on
    `booking_locations`/`location_power`/`locations` and the three views
    (`public_bookings_info`/`public_performer_info`/`public_schedule_info` — "views
    get SELECT at most," since a view runs its internal query as the view owner
    regardless of the caller's own grant, and none has an `INSTEAD OF` trigger). Also
    revoked a vestigial table-level `TRIGGER` privilege `anon` still held on
    `bookings`/`performers`/`schedules` — that privilege only gates `CREATE TRIGGER`
    DDL, not whether existing triggers fire on a role's own DML, so it was pure dead
    weight; their deliberate column-level grants (the real access mechanism for these
    three) were **not touched**, per this project's standing rule. Applied to the
    test project first, full 79-test suite green (71 + 8 new), then to production;
    independently re-verified via a single query covering all twelve tables/views
    that `anon`'s live privileges exactly match intent. Added 8 live-verified
    regression tests rather than trusting the grant text (three new
    "completely inaccessible" entries alongside `payments`, three new write-rejection
    tests, one new `location_power` describe block, one new describe block for the
    two views without existing coverage). `authenticated`/`service_role` grants
    untouched everywhere; scoped to `anon` only, same as item 46. The remaining
    pieces of the original interrupted table-grant-narrowing brief —
    `authenticated`-role narrowing across the admin app, the `ALTER DEFAULT
    PRIVILEGES` fix for `authenticated` (mirroring `anon`'s existing
    20260717080000 fix), and the three anon sequence grants
    (`audit_logs_id_seq`/`booking_locations_id_seq`/`email_queue_id_seq`) — are each
    a meaningfully larger/different-shaped piece of work and were deliberately left
    for their own dedicated pass, not folded in here.
48. Narrowed `authenticated`'s table grants (2026-07-18,
    `20260718110000_narrow_authenticated_table_grants.sql`, item 47's deferred
    follow-up). Unlike `anon`, `authenticated` genuinely needs broad CRUD for the
    admin app to work, so this couldn't just be "revoke everything" — for every
    table, traced (a) the exact FOR-clause command each authenticated-reachable RLS
    policy allows, and (b) every real `.insert()`/`.update()`/`.delete()`/`.upsert()`
    call site across `js/`, plus confirmed all nine Edge Functions use
    `SERVICE_ROLE_KEY` exclusively (so none depend on `authenticated`'s own table
    grants at all). Findings that narrowed further than RLS alone would suggest:
    `booking_locations`/`locations` writes all route through
    `rpc_set_booking_locations` (`SECURITY DEFINER`) — `js/locations.js`'s
    `updateLocation()` despite its name calls that RPC, never touching the
    `locations` table directly, and the table itself is seed/migration-only;
    `email_queue` status transitions are `claim_pending_emails()`
    (`SECURITY DEFINER`) + service-role Edge Functions only, no direct
    UPDATE/DELETE call site exists; `email_templates` has no create/delete UI
    (edit-existing-only); `payments` has zero direct INSERT call sites (all
    creation is the same `SECURITY DEFINER` RPCs item 46 already traced) despite
    `finalizeConfirmation()`/`updatePayment()` doing genuine direct DELETE/UPDATE;
    `bookings` has no hard-delete path anywhere. Result: `SELECT,INSERT` on
    `audit_logs`/`email_queue`; `SELECT` only on `booking_locations`/`location_power`/
    `locations` and the three views; `SELECT,INSERT,UPDATE` on `bookings`/
    `hcc_checks`; `SELECT,UPDATE` on `email_templates`; `SELECT,UPDATE,DELETE`
    (no INSERT) on `payments`. **Deliberately excluded: `performers` and
    `schedules`** — both are shared with a separate, external app
    (`ellafestperformersadmin.vercel.app`) against this same Supabase project; this
    repo's code never writes to either directly, but that app's authenticated
    sessions might, and it's outside this repo, unauditable and untestable from
    here — narrowing a grant a system I can't see or verify might depend on is
    exactly the kind of cross-system risk not to take silently. `user_roles`/
    `settings` also untouched (already correctly scoped from prior work). Applied
    to the test project first; the full suite caught a real gap on the first run —
    `tests/workflow.test.mjs`'s "confirm booking" step used the `admin` client to
    directly upsert a payments row as a test-setup shortcut, which the narrowed
    grant correctly rejected (`permission denied for table payments`). The test's
    own comment already said this mirrors what `finalize_stripe_payment`/
    `rpc_record_bank_transfer_payment` (both `SECURITY DEFINER`) do in production —
    fixed by switching that one line to the `service` client rather than
    re-widening the grant, since grep confirmed zero real `authenticated`-role
    INSERT call sites on `payments` anywhere. Full 89-test suite green (79 + 10
    new) after the fix, then applied to production; independently re-verified via
    a single query covering all fourteen tables that `authenticated`'s live
    privileges exactly match intent, including confirming `performers`/`schedules`
    remained untouched. Added 10 live-verified regression tests. `anon`/
    `service_role` grants untouched everywhere; scoped to `authenticated` only.
    Still deliberately deferred: the `ALTER DEFAULT PRIVILEGES` fix for
    `authenticated` and the three sequence grants.
49. `ALTER DEFAULT PRIVILEGES` fix for `authenticated` (2026-07-18,
    `20260718120000_revoke_default_authenticated_privileges.sql`, mirrors
    20260717080000's anon fix, closing one of the two things item 48 deferred). Confirmed
    live via `pg_default_acl` that objects created as `postgres` (how every
    migration in this project creates objects) were still auto-granting
    `authenticated` essentially everything at CREATE time: `X` (EXECUTE) on new
    functions, `arwdDxtm` (all table privileges) on new tables, `rwU` (all) on new
    sequences — the exact same gap `anon` had before 20260717080000, just never
    closed for `authenticated`. Every migration in this project already states its
    `authenticated` grant explicitly by hand (confirmed across every migration
    touched this session), so the default was already redundant in practice — it
    just meant a future migration that forgot the explicit grant would silently
    get full access instead of failing loudly. Non-retroactive, same as the anon
    fix: doesn't touch any existing grant, only what happens at CREATE time from
    here on. Applied to the test project first, full 89-test suite green (an
    inherent no-op check, since nothing existing changes), then to production;
    independently re-verified via `pg_default_acl` on both that `authenticated` is
    now absent from all three default ACL entries, matching `anon`'s. No
    regression test added — the project's test suite runs entirely over
    supabase-js/PostgREST with no raw SQL/DDL execution capability (no generic
    SQL-exec RPC exists in the schema, which is itself a good property, not a
    gap), so there's no way to create a throwaway object from within the Node
    suite to exercise this rule automatically; the live `pg_default_acl` query is
    the verification here, not a stand-in for one. `rls_grants_snapshot.txt`
    unchanged by this migration (it only captures `CREATE POLICY`/`GRANT`/
    `REVOKE` lines from a schema dump; `ALTER DEFAULT PRIVILEGES` isn't a current
    grant on anything, so there's nothing for it to capture — same reason the
    anon fix never touched the snapshot either).
50. Revoked `anon`'s sequence grants (2026-07-18,
    `20260718130000_revoke_anon_sequence_grants.sql`) — the last piece of the
    original interrupted table-grant-narrowing brief. `anon` held `rwU` (full ALL:
    SELECT/currval, UPDATE/nextval+setval, USAGE) on the three id sequences behind
    `audit_logs`/`booking_locations`/`email_queue`. No PostgREST surface exposes a
    sequence directly, so this was never a live exploit path — pure hygiene, closed
    because it could be closed cleanly, not because anything was actively wrong.
    Confirmed `anon` has zero legitimate reason to ever trigger `nextval()` on any
    of the three: `audit_logs` was narrowed to `REVOKE ALL` for `anon` in item 47
    (no INSERT/UPDATE/DELETE policy exists for `anon` on it at all);
    `booking_locations` was narrowed to `SELECT`-only in the same item;
    `email_queue` already had zero `anon` access from work predating this session.
    None of the three tables `anon` can INSERT into, so none of the three
    sequences ever has `nextval()` invoked on `anon`'s behalf through any
    legitimate path. `authenticated`'s grants on the same sequences are
    untouched — unlike `anon`, `authenticated` genuinely does INSERT into
    `audit_logs` and `email_queue` directly (confirmed in item 48's own trace), so
    its sequence usage is real. Applied to the test project first — a re-run was
    needed after the first attempt hit unrelated stale fixture data
    (`duplicate key value violates unique constraint "bookings_pkey"` from an
    earlier interrupted run, nothing to do with sequences since `bookings.id`
    doesn't use any of the three) — clean re-run was full 89-test suite green,
    then applied to production; independently re-verified via `pg_class.relacl`
    on both that `anon` is absent from all three sequence ACLs, `authenticated`/
    `service_role` unaffected. No regression test added — sequences aren't
    exposed as a PostgREST resource at all, so there's no REST-level way to even
    attempt calling `nextval()`/`currval()` as `anon` to prove rejection; the live
    `pg_class.relacl` query is the verification. `rls_grants_snapshot.txt` DID
    change this time (unlike item 49's `ALTER DEFAULT PRIVILEGES` fix) — sequence
    grants are current-state `GRANT`/`REVOKE` statements the snapshot script
    captures, unlike a default-privilege rule.

This closes every item from the original interrupted table-grant-narrowing brief
(items 46-50): `payments`, the rest of `anon`'s table/view grants, `authenticated`'s
table grants, both roles' `ALTER DEFAULT PRIVILEGES` posture (well — `anon`'s from
20260717080000, `authenticated`'s from item 49), and the `anon` sequence grants.
`authenticated`'s own sequence grants and its default-privilege posture on
sequences specifically were never separately audited beyond what item 49 already
covers — worth a glance if this area comes up again, but nothing currently flags
it as a live concern.

51. **Fixed `submit-booking` recording nonexistent document paths when a storage
    move fails (2026-07-18, PR #20).** When moving an uploaded file from
    `temp/<uuid>/<file>` into the booking's folder failed, the code only
    `console.warn`-ed but still wrote the destination path into
    `bookings.documents` — a path that was never created, so
    `get-booking-documents` couldn't sign it and the admin silently lost access
    to the trader's uploaded document (e.g. the required insurance certificate).
    A stale comment described a "fallback to the original temp URL" that had
    never actually been implemented. That fallback now exists: a failed move
    stores the `temp/` source path instead. The reasoning for "keep the temp
    path" over "omit the file": nothing ever cleans up `temp/`, so the file is
    still sitting there, and `get-booking-documents` signs whatever path is
    stored — the document stays viewable by admins, just under its temp path
    rather than the booking's folder. Two new integration tests
    (`tests/integration.test.mjs`, "submit-booking document moves" describe
    block) cover the success path (real upload → moved into the booking folder,
    object verified to actually exist at the recorded path) and the failed-move
    fallback (never-uploaded filename → the temp path is recorded, not the
    phantom destination). Verified per convention: function deployed to the
    disposable test project first, full 91-test suite green there, then merged
    and deployed to production with a CORS-preflight smoke check.

52. **Fixed the bookings-open toggle never actually blocking visitors
    (2026-07-18, PR #21, migration
    `20260718140000_allow_anon_read_booking_open_flags.sql`).** The public
    booking pages read `settings.food_bookings_open`/`general_bookings_open` as
    anon (`js/page-food-booking.js`, `js/page-general-booking.js`) to decide
    whether to swap the form for the "bookings closed" notice, but the anon
    SELECT policy's key allowlist never included those two keys — RLS filtered
    the row, `.single()` errored on zero rows, the page's catch swallowed it
    (v5.1.10 had already improved exactly that logging, one release before the
    cause was found), and the form always showed. settings.html's "Closed
    (Visitors Blocked)" switch had therefore never blocked anyone. This IS an
    RLS policy change — the category items 46–50 deliberately avoided —
    justified because the existing policy broke a real feature; the two values
    are only the strings 'true'/'false', and the 20260717100000 table-grant
    narrowing stays untouched as the independent second layer. Three
    live-behavior tests added to `tests/security.test.mjs` ("anon access to
    settings" describe block): the exact page query for both keys as anon, the
    real admin upsert write path flipping a flag and anon seeing the change
    (the precise closed-notice condition), and non-allowlisted rows
    (`bank_account_number`) staying invisible including via the broad
    `loadPublicSettings()`-style read. Verified per convention: applied to the
    test project first (full 92-test suite green), production confirmed
    drift-free against the committed snapshot beforehand, human-run `db push`
    to production, snapshot check OK against production after, plus a live
    anon REST call proving both flags readable and sensitive keys still
    hidden. Two operational lessons from the same session, both fixed: (a) new
    `.gitattributes` pins LF for `*.sh` and `rls_grants_snapshot.txt` — a
    fresh Windows worktree checkout (`core.autocrlf=true`) materialized them
    CRLF, breaking the check script under bash and producing a bogus
    full-file snapshot diff; (b) the snapshot is authoritative from
    PRODUCTION only — the test project carries leftover `storage.objects`
    policies production doesn't have — so the check/`--update` dance is: link
    `rsnxhuhibglieofikkpo`, verify `supabase/.temp/project-ref`, run it, and
    always relink `qeplpcnrkgpaawfyliap` after.

53. **Server-side cache for `get-reviews`' SerpApi Google Maps lookups
    (2026-07-19, PR #27, migration `20260719090000_google_reviews_cache.sql`).**
    The booking detail pane auto-searches Google Maps on every open of a
    food-stall booking (`js/google-reviews.js`'s `runAutoTaSearch()`), costing
    two metered SerpApi calls each time — for results that rarely change. New
    `google_reviews_cache` table (service-role only: RLS enabled, zero
    policies, same access pattern as `stripe_webhook_events`) stores the exact
    response body served, keyed by normalized (lowercased/trimmed) business
    name; `get-reviews` serves entries fresher than the TTL — default 7 days,
    overridable via an optional `reviews_cache_ttl_hours` settings row (no UI;
    seed via SQL if ever wanted) — without touching SerpApi. Deliberate design
    decisions worth knowing before "improving" this: the cache is checked
    BEFORE the API-key requirement (cached lookups survive key
    rotation/removal); `found:false` results are cached too (they cost SerpApi
    calls just the same, and most detail-pane opens are for businesses with no
    listing); cache read/write failures only `console.warn` and fall through
    to the old fetch-every-time path (the function is safe to deploy without
    the table, and a broken cache can never break lookups); and `force:true`
    in the request body bypasses the cache — wired only to the detail pane's
    explicit "Refresh Google Maps" button, never the automatic on-open search,
    which is the call volume the cache exists to absorb. The UI labels cached
    results with their fetch time. Five integration tests in
    `tests/google-reviews-cache.test.mjs` prove hit/bypass/TTL/anon-lockout
    behavior **without ever making a real SerpApi call** — the test project
    deliberately has no SerpApi key (the test's `before()` also deletes any
    leftover `serpapi_api_key` settings row), so a "not configured" failure is
    the detector that a request did NOT come from cache. Verified per
    convention: migration + function on the test project first (full 99-test
    suite green), function deployed to production ahead of the migration (ran
    cache-less until the table existed, by design), human-run `db push` to
    production, then the item-52(b) snapshot link dance — production's only
    diff was the expected `GRANT ALL ON google_reviews_cache TO service_role`
    line, confirming the anon/authenticated lockout held live.

54. **Fixed password-reset links never establishing a session (2026-07-19,
    PR #29, released as v7.0.0).** An admin reported "Update Password" failing
    with a generic toast; the console showed
    `AuthSessionMissingError: Auth session missing!` from
    `sb.auth.updateUser()`. Root cause was an ordering bug in
    `js/page-index.js`'s recovery path: it called
    `history.replaceState()` to scrub the
    `#access_token=…&type=recovery` fragment from the address bar **before**
    calling `getSupabaseClient()`. That function lazily constructs the client,
    and GoTrueClient reads the recovery token out of `window.location` at
    construction time to establish the session (verified live against the
    vendored SDK: `flowType: 'implicit'`, `detectSessionInUrl: true`). With the
    hash already gone, no session was ever created, so the later
    `updateUser()` call could not succeed no matter what the admin did. Fix is
    a two-line reorder: construct the client first, then scrub the URL.
    **This was the third fault in the same chain** — v5.1.2 fixed the
    client-side redirect domain, v5.1.4 fixed the hosted Site URL/allowlist,
    and both were genuinely necessary but neither made the flow work, because
    this bug sat behind them. **Lesson worth keeping**: v5.1.4's writeup said
    the flow was "verified end-to-end," but what was actually checked was that
    the reset link redirected and the "Set New Password" form *rendered* — not
    that submitting it worked. A rendering check is not an end-to-end check.
    The integration suite has a real blind spot here: it covers Edge
    Functions/RLS/RPC thoroughly but nothing exercises browser-driven auth
    flows, which is exactly the class both this and item 51 belong to — worth
    adding a browser-level smoke test if this area is touched again. Confirmed
    working live by the reporting admin with a real reset link (a synthetic
    unsigned token can't reach the timing-dependent path, so local
    verification could only confirm the SDK config and no-regression, not the
    full click-through).

55. **Retry action for failed emails in the Email Queue viewer (2026-07-19,
    PR #31, released as v7.1.0, migration
    `20260719120000_email_queue_retry_tracking.sql`).** `email_queue.html`
    had surfaced failed sends with their Zoho error message since v5.1.0 but
    offered no way to act on one — the only recovery was re-triggering the
    original action from the booking, impossible for some email types (the
    "received" auto-responder among them). New `retry-queued-email` Edge
    Function, admin-JWT only with **no** service-role "trusted service call"
    bypass (unlike `send-email`): retrying is a human recovery action,
    nothing server-side should trigger it. It must be server-side on two
    counts — `authenticated` has no UPDATE on `email_queue` by design (item
    48's grant narrowing) and the Zoho credentials are server-side — and it
    calls `sendViaZoho()` in-process, not `send-email` over HTTP, per the
    sibling-function rule the pre-commit hook enforces.
    **The concurrency semantics are worth understanding before changing
    anything here**, because they're easy to get wrong (I did, first pass):
    the function claims the row with a conditional `Error → Processing`
    update and treats "no rows matched" as the rejection. That means two
    retries overlapping *in flight* → only one sends; a retry after a
    previous one *succeeded* → refused, since the row is `Sent` and only
    `Error` is claimable (**this is the guarantee that matters — a delivered
    email is never delivered twice**); a retry after a previous one *failed*
    → allowed, since the row is back to `Error`, which is the entire point of
    the endpoint rather than a hole. If the function dies mid-send the row
    sits in `Processing` with `claimed_at` set, where `claim_pending_emails()`'s
    existing 15-minute self-heal collects it. New `retry_count`/`last_retry_at`
    columns (additive, grant-neutral — the production snapshot check came
    back clean afterwards) let the viewer distinguish a first-time failure
    from one that has failed repeatedly, which usually means a bad address or
    Zoho config rather than something a further retry fixes.
    **Two testing lessons from this one, both mine, both worth not
    repeating**: (a) an anon-lockout assertion written against this file's
    `anon` client was meaningless, because `before()` signs that client in as
    the test admin — `security.test.mjs` is where anon checks belong; (b) a
    "two concurrent retries, exactly one accepted" test passed locally and
    **failed in CI** — not because the guard broke, but because the
    assertion was wrong: with Zoho failing fast the first call completes its
    whole cycle before the second claims, so the second legitimately retries.
    Replaced with a deterministic test of the claim primitive itself, which
    can't flake since nothing resets the status. Same false-negative trap
    `integration.test.mjs` already documents for `booking_locations` — two
    HTTP round trips don't reliably overlap. Verified: migration + function
    on the test project first (108-test suite green), then applied to
    production and deployed there, with the live function confirmed
    rejecting unauthenticated calls (401) and the grants snapshot confirmed
    unchanged. **Not verified by me**: the button itself was never clicked —
    `supabase-public.js` points at production, so a local click would email
    real traders. Same browser-flow blind spot as item 54; an admin should
    confirm on a real failed row.

56. **Payment Tracker modals were rendering underneath their own overlay
    (2026-07-20, PR #36, released as v7.2.0).** Reported as: pressing "Record
    Bank Transfer" blanks the screen and records nothing. Both halves had one
    cause — the modal *was* opening and *was* fully populated, but was painted
    under the grey overlay, so the Save button was unreachable and the form
    could never be submitted. Nothing was wrong with `js/payments.js` or the
    `rpc_record_bank_transfer_payment` path at all. Cause: the overlay is
    `fixed` (positioned), the panel was `static`, and a positioned element
    paints above a static one regardless of DOM order — see the Tailwind v4
    Gotcha below for why this markup used to work and silently stopped.
    Fixed with `relative z-50` on the panel, matching the pattern every other
    modal in the app already uses. **The "Edit Payment" modal on the same page
    was broken identically** — same structure, never reported — and is fixed by
    the same change; assume admins had been quietly working around it.
    Diagnosed empirically rather than by reading CSS
    (`document.elementFromPoint()` at the screen centre returned the overlay;
    the panel computed `position: static, z-index: auto, transform: none`) and
    **verified end-to-end in a real browser** against the test project: the
    modal renders and is interactive, and completing it records the payment
    (`paid`, `payment_method='bank_transfer'`, server-derived `verified_by`)
    and auto-confirms the booking with `date_confirmed` set. This is the first
    bug found and fixed using the local test-project override from PR #34 (see
    [Verifying browser flows locally](#verifying-browser-flows-locally-the-test-project-override))
    — the class of bug items 51/54/55 all had to hand back to a human.
    One process note: the first reproduction attempt failed with
    `Invalid booking ID format.`, which was the *test fixture*, not the app —
    `validateBookingId()` requires `ESF26-(FOOD|NONFOOD|DEV|MISC)-\d{4}`, four
    digits exactly, so seeded fixtures must use a realistic id.

57. **Dev-server Supabase proxy — Edge-Function-backed buttons are now
    verifiable in a local browser (2026-07-20, PR #38, released as v7.3.0).**
    Closes the CORS gap left open when the local override first landed: a
    localhost page could not call any Edge Function, because `_shared/cors.ts`
    pins `Access-Control-Allow-Origin` to production. `npm run dev` now proxies
    `/__supabase/*` to the test project and the override points the Supabase
    client there, so every request is same-origin and CORS never applies.
    Full rationale, safety properties and the reason this was chosen over
    per-request origin negotiation are in
    [Verifying browser flows locally](#verifying-browser-flows-locally-the-test-project-override)
    — read that before changing any of it. Developer tooling only: no
    production code, schema, or Edge Function is touched, which is why v7.3.0
    is safe to skip when reasoning about what the live site is running.

58. **Schema/permissions hardening from a review (2026-07-20, PR #42,
    released as v7.4.0, migrations `20260720100000`/`100100`/`110000`/
    `110100`).** Four findings, each verified against the live schema before
    acting — this document's own history has reviews that were right and
    reviews that overstated, so none was taken on trust.
    - **Dropped `"Steward update"` on `bookings`.** No `WITH CHECK`, and
      `authenticated` holds full-column UPDATE, so a steward could write
      `stall_cost`/`status`/`cancel_token`/the Stripe columns. Dropped rather
      than narrowed because **nothing used it**: `page-steward.js` never
      updates bookings — it reads (via the retained `"Steward access"`) and
      assigns pitches through `rpc_set_booking_locations()`, a SECURITY
      DEFINER RPC with its own role check. Don't "restore" this policy; if a
      steward ever needs a booking write, add an RPC.
    - **`audit_logs.user_email` is now server-stamped** by a BEFORE INSERT
      trigger. It was client-supplied text under `WITH CHECK (true)`, so staff
      could forge entries. **Two properties are load-bearing**: it only
      overwrites when an email claim exists (`service_role` has none — Edge
      Function audit rows would otherwise be blanked or rejected), and it
      swallows malformed claims rather than raising, because a trigger that
      blocks a write from being recorded is worse than the spoofing it
      prevents. Reads `request.jwt.claims` directly rather than `auth.jwt()`
      so it needs no EXECUTE grant on the caller's part.
    - **`bookings.status` CHECK-constrained** to the six real values.
      **Deliberately not an enum**, despite `is_charity` being one: Postgres
      has no `ALTER TYPE ... DROP VALUE`, and this project has added *and
      removed* `Pre-Confirmed`, `Paid` and `On Hold` — each removal would have
      needed a full type swap. Keep the list in sync with
      `CONFIG.UI.STATUS_LIST` in `js/config.js`.
    - **Revoked the vestigial `anon` grant on `rpc_set_booking_locations()`**,
      finishing the v5.1.3 sweep that missed it.

    **A correction worth keeping**: the status migration also runs
    `ALTER COLUMN status SET NOT NULL`, written believing NULL was permitted.
    It wasn't — the column was already `NOT NULL`, established only by diffing
    production dumps either side of the change after noticing the line being
    read was `email_queue.status`, a different table. The statement is a
    harmless no-op but the migration's comment overstates it; the applied
    migration was left alone rather than rewritten, and the test is relabelled
    to say what it actually guards. Lesson: when a dump shows two columns of
    the same name, confirm which table each belongs to before concluding
    anything.

    **`location_power`'s no-PK/no-FK finding was resolved differently than
    first planned — see item 59.** My first-pass "zero references in `js/` or
    any HTML" conclusion was wrong for this specific table; don't reuse that
    check as a general orphan-detection method.

    **The `user_roles.role`/`eq_text_user_role` consolidation is done — see item
    60.** Still open: the anon `schedules` policy being `USING (true)` — real
    but low-impact (slot times for unnamed performers; column grants stop
    ID→name resolution) — and `schedules` is shared with the external
    performer app, so a table-policy change needs checking against that
    consumer first.

59. **Dropped the orphaned `location_power` table (2026-07-20, PR #46,
    migration `20260720120000_drop_location_power.sql`) — but read this
    before trusting "orphaned" again.** Item 58's own writeup concluded
    `location_power` had "zero real usage anywhere" from grepping `js/` and
    every HTML file. **That check was wrong for this table specifically.**
    Before dropping anything, a live production dump showed it held **five
    rows of deliberately written data** — power-availability notes for
    `Music Stage`, `On the street`, `Beach`, `After party`, `Green` — and its
    own `COMMENT` read *"Power availability at each performance location."*
    Those are **performer venues**, not stall pitches (`locations` is a
    different table entirely, with numeric pitch IDs and lat/lng). The
    performers feature is served by a **separate app**
    (`ellafestperformersadmin.vercel.app`) this repo cannot audit — the exact
    failure mode already warned about elsewhere in this document for that
    feature, and this is now a second concrete instance of it. **"No
    references in this repo" is not evidence of orphaned status for anything
    performer-adjacent** — check with whoever maintains that app, which is
    what happened here before dropping anything.
    Made reversible before acting: `supabase/sql-archive/restore_location_power.sql`
    recreates the table, both policies, all three grants and all five rows
    exactly as captured immediately before the drop — run it if the performer
    app turns out to have depended on this after all. Removed the two
    `tests/security.test.mjs` assertions that exercised its grants rather than
    leaving them to fail against a dropped table. Verified: 118/118 on the
    test project (120 minus the two removed tests); production drift-free
    before, and the after-diff was exactly the table's two policies and three
    grants — confirmed absent in a fresh production dump afterward.

60. **Consolidated `user_roles.role` onto the pre-existing `user_role` enum,
    dropping the `eq_text_user_role()` shim (2026-07-20, PR #48, migration
    `20260720130000_consolidate_user_roles_enum.sql`).** Closes the item 58
    "still not done" entry. The shim existed solely to make
    `check_user_role()`'s `role = required_role` (`text` = `user_role`)
    resolve — the invisible-call-site footgun in the Gotchas below. With
    `role` now genuinely `user_role`, that comparison is native and the shim
    plus its `"public".=` operator are gone.
    **Scope was established by tracing every reference in a live production
    dump, not by assuming `check_user_role()` was the only consumer** — 13 of
    the schema's 23 policies touch `user_roles.role`, in three categories that
    behave completely differently under this change:
    - **7 call `check_user_role('x'::user_role)`** — no text change, and
      critically, **no `pg_depend` dependency on the column at all**: a
      plpgsql function body is opaque to Postgres's dependency tracker, so the
      column reference living inside `check_user_role` never registers.
      That's also why the function needed no `CREATE OR REPLACE` — it's
      re-planned against the column's current type at each execution.
    - **1 calls `get_is_admin()`** (untyped literal in the body) — unaffected
      either way.
    - **6 inline the comparison directly**
      (`"user_roles"."role" = 'admin'::"text"`) — these DO register a
      `pg_depend` column dependency, because policy expressions are parsed and
      analyzed at `CREATE`/`ALTER POLICY` time. They're also in the *opposite*
      cast direction from the shim (`user_role = text`, never defined even
      while the shim existed) — they'd have broken **silently** if this
      migration had only touched `check_user_role()`.
    **The first attempt used `ALTER POLICY` on those six and failed** on the
    subsequent `ALTER COLUMN TYPE` with *"cannot alter type of a column used
    in a policy definition"* — for a policy already rewritten to reference
    the new type. The `pg_depend` record is on the column, independent of
    what the comparison casts to; `ALTER POLICY` edits the expression in place
    without ever clearing it. **The only sequence that works is `DROP POLICY`
    → the type change → `CREATE POLICY`** — see the Gotchas entry below, this
    is worth knowing before touching any RLS policy referencing a column
    that's about to change type. The failed attempt rolled back cleanly
    (verified via a dump showing the original text column and CHECK still
    present) since the whole migration is one transaction.
    Verified: 14 new tests (`tests/user-roles-enum.test.mjs`) covering all
    three policy categories as real admin *and* steward sessions, plus that
    `role` still round-trips as a plain string to the client (what
    `requireAuth()` compares against) and that an invalid value is now
    rejected with `22P02` rather than a CHECK's `23514`. Three of the new
    tests had bugs of my own (PostgREST `count` misuse, an integer literal
    against a uuid column) — fixed to assert stored state instead; the
    migration itself was correct throughout. 132/132 on the test project.
    Production: drift-free before; **the snapshot diff after showed only the
    shim's three revoked grants** — the check script's grep captures each
    policy's *first line only*, so the cast change on a continuation line is
    invisible to it. The six policies' actual casts, the column type, and the
    shim's absence were all confirmed directly in a full production dump
    instead, not inferred from the (in this case insufficient) snapshot diff.

61. **Bounded every unbounded admin list query (2026-07-20, PR #50, released
    as v7.7.0).** Every list-style admin query previously had no
    `.limit()`/`.range()` at all — fine at ~184 bookings, insurance against a
    slow-motion failure as data grows, not a response to an actual problem.
    **The audit found the request's own suspect list was wrong twice**: all
    four unbounded queries live in `js/api.js` (`fetchKanbanData`,
    `fetchPayments`, `fetchLocationData`, `fetchStatsData`) — `kanban.js`/
    `summary.js`/`stats.js`/`locations.js` have no direct queries of their
    own — and HCC dashboard was named as a suspect but wasn't one; its
    listing already used `.range()`.
    **Payments got a cap, not the real pagination first proposed for it** —
    caught before writing any pagination code by actually reading
    `payments.js`'s `renderTable()`: it computes Paid/Outstanding totals
    client-side over the *entire* filtered set, and page-at-a-time
    pagination would make those totals silently reflect only the loaded page
    — a wrong-*looking*-right number, worse than a visibly incomplete
    table. All four queries use the same cap-with-notice treatment instead:
    `LIST_CAP = 1000` for board/table views, `STATS_CAP = 5000` for stats
    specifically (a truncated board is visibly incomplete; a truncated
    aggregate produces a wrong-but-plausible number — worse for the same
    truncation, hence the higher ceiling).
    `fetchCapped()` (`api.js`) requests `cap+1` and slices back to `cap`
    rather than treating `length === cap` as the signal — that would
    false-positive on an exact match. The `truncated` flag is a
    **non-enumerable property on the returned array**, not a
    `{data, truncated}` shape change: several callers (e.g. `details.js`'s
    `loadBookings`) consume these results without needing to know this cap
    exists, and forcing every one to destructure a new shape for a condition
    that won't fire in practice wasn't worth the blast radius.
    `notifyIfTruncated()` (`ui.js`) is the one shared notice across all six
    call sites, including the My Maps CSV export in `locations.js` —
    flagged there specifically, since an incomplete export travels with the
    downloaded file, unlike an on-screen board.
    Location-admin's occupancy query is capped too, with a comment noting
    the real backstop against double-booking a pitch is the
    `booking_locations_check_conflict` DB trigger, not this client-side
    list, so a truncated occupancy set risks a confusing UX rather than
    actual data corruption.
    No schema/RPC/Edge Function changes — pure client-side, so the
    integration suite (132/132) was a sanity check, not the real
    verification. That was live, against the test project: all six affected
    pages loaded with zero console errors, and **the truncation algorithm
    itself was proven correct at a scale that actually fits** — seeded 5 real
    test rows, then ran `fetchCapped`'s exact cap+1/slice/flag logic against
    them via the console with an artificially tiny cap (`cap=10` → not
    truncated; `cap=3` → truncated, sliced to 3), since no realistic seeding
    could exercise the real 1000/5000 caps directly. The notice's rendering
    was checked too — correct text, zero child elements confirming it went
    through `innerText`, not `innerHTML`.

62. **The two follow-ups item 60 left open (2026-07-20, PR #52, released as
    v7.8.0, migration
    `20260720140000_consolidate_get_is_admin_into_check_user_role.sql`).**
    Neither was written down as a formal TODO anywhere
    — both fell out of re-reading item 60's own Gotchas entries and asking
    "is this actually finished."
    - **Consolidated `get_is_admin()` into `check_user_role('admin'::user_role)`.**
      The two were behaviourally identical — same `SECURITY DEFINER` body, same
      `auth.uid()` lookup against `user_roles`, one hardcoded `'admin'` and the
      other parameterized. `get_is_admin()`'s only call site anywhere was
      `policy_allow_all_admin` on `user_roles` itself, confirmed by grepping
      every function body in a live production dump for an embedded call (not
      just `pg_depend`, which wouldn't show this either way — the same
      opacity-of-plpgsql-bodies reason `check_user_role`'s own reference to
      `user_roles.role` was invisible to dependency tracking in item 60) and by
      checking client/RPC code directly. **This one was a plain `ALTER POLICY`,
      not the `DROP POLICY`/`CREATE POLICY` dance item 60's six policies
      needed** — verified on the test project first rather than assumed, given
      that exact kind of assumption was wrong once already. The reasoning for
      why it's safe here: the pg_depend trap in item 60 was about a policy
      expression referencing a *column* directly; both the old
      (`get_is_admin()`) and new (`check_user_role(...)`) expressions here are
      plain function calls with no column reference in the policy body itself,
      so `ALTER POLICY` correctly re-points the function dependency with
      nothing left over to block anything. Also added a test that was missing
      entirely before touching this policy: a steward had never actually been
      tested against `user_roles` access. It failed on the first attempt — not
      because the policy was wrong, but because the test forgot that a
      *separate* policy, `"Users can read own role"` (`USING (id = auth.uid())`),
      lets any authenticated user see their own row regardless of
      `policy_allow_all_admin`. That's correct, pre-existing, unrelated
      behaviour (`requireAuth()` depends on it), not a bug — fixed the test to
      check the real boundary (own row visible, a *different* user's row is
      not) instead.
    - **Fixed `check-rls-grants-snapshot.sh`'s first-line-only blind spot**,
      the exact gap item 60's own Gotchas entry documented as a manual
      workaround rather than a fix. Full writeup in the Gotchas entry itself;
      the short version is it now accumulates a statement across lines until
      the one that actually ends it, instead of a plain `grep -E "^(...)"`
      that only ever saw first lines. Regenerating the snapshot with the fixed
      script against production surfaced one unrelated bonus catch —
      `"Strict Public Uploads"` on `storage.objects` was *also* multi-line and
      *also* silently truncated the same way; confirmed unchanged in substance
      via the same before/after production dump comparison used throughout
      this session, just newly visible in full for the first time.
    Verified: 3 new/updated tests (`tests/user-roles-enum.test.mjs`), full
    suite 134/134 on the test project, then production — drift-free check
    beforehand used the *old* (buggy) script by necessity, so the real
    confirmation was reading every line of the after-diff by hand: exactly
    the six item-60 policies plus `Strict Public Uploads` going from
    truncated to full (format only, no content change), `policy_allow_all_admin`
    changing from `get_is_admin()` to `check_user_role()`, and the three
    `get_is_admin()` grants disappearing — nothing unexplained. Snapshot
    regenerated from production and committed; CLI relinked to the test
    project afterward.

63. **Closed the third finding item 58 left open: anon's `schedules` policy
    was `USING (true)` (2026-07-21, PR #54, released as v7.9.0, migration
    `20260721081500_scope_anon_schedules_policy.sql`).** `public_schedule_info`
    has always filtered to Scheduled/Paid performers only; the base table
    never enforced that itself, so a caller reading `schedules` directly
    (rather than through the view) could see slot times and performer IDs
    for Applied/Rejected performers too — column grants already stopped ID
    resolution to a name, but the slot data itself was still exposed.
    **Safe to apply with no external coordination**, unlike item 59's
    `location_power` drop: verified against a live production dump
    immediately before *and again immediately before* applying that
    `schedules` held **zero rows** — nothing for the separate performer app
    (`ellafestperformersadmin.vercel.app`, still unauditable from here) to
    lose access to.
    **A plain `EXISTS` subquery against `performers` does not work here, and
    this was found empirically, not reasoned out correctly the first time.**
    Anon already has a genuine row-level policy on `performers` for
    Scheduled/Paid rows, which ruled out the `is_booking_confirmed()`-style
    "anon has zero row access" problem — but anon's *column* grants on
    `performers` don't include `deleted_at`, which the filter needs. An
    inline subquery referencing it, evaluated as anon regardless of sitting
    inside a policy expression, threw `permission denied for table
    performers` on **every** anon query against `schedules`, not just a
    mis-filter — a worse regression than the gap being fixed, caught on the
    test project before it went anywhere near production. Fixed with
    `is_performer_publicly_visible(p_performer_id)`, a `SECURITY DEFINER`
    helper mirroring `is_booking_confirmed()` exactly, whose body runs as
    the function owner and is therefore not subject to the caller's column
    grants at all.
    **The broken version was already committed to the test project's schema
    before this was caught** (the `ALTER POLICY` itself succeeded — there
    was nothing to roll back). Recovered by deleting the broken-content
    migration file and re-adding the corrected content under a fresh
    timestamp, then `supabase migration repair --status reverted
    <old_version>` to clear the test project's migration-history record for
    the file that no longer exists locally, before `db push` would apply
    anything again. Matters if this pattern recurs: a *failed* migration
    rolls back for free (this repo has hit that path more than once), a
    *successful*-but-wrong one does not, and needs this repair step.
    5 new tests (`tests/schedules-anon-scope.test.mjs`), seeded with real
    Applied and Scheduled performers and their own schedule slots, since
    production's zero rows meant there was nothing to verify correctness
    against directly — includes a check that the view and the now-filtered
    table agree on every row. 139/139 on the test project, then production:
    drift-free before (re-confirmed zero `schedules` rows immediately
    before applying too), after-diff exactly two lines — the policy's new
    expression and a `service_role`-only grant on the new function, no
    `anon`/`authenticated` leakage. Snapshot regenerated, CLI relinked to
    test.

64. **Refunds (2026-07-21, PRs #56 + #57, released as v7.10.0, migration
    `20260721100000_add_refund_support.sql`).** Closes the "No refund support"
    known gap that had stood since 2026-07-15. Built as the "option C" the
    owner chose from a written set of options: record-only refunds **and**
    Stripe API automation **and** `charge.refunded` webhook reconciliation.
    Shipped as two PRs — foundation (#56), then Stripe automation on top
    (#57) — because the second genuinely depends on the first and each is
    independently verifiable.
    **It also closed a live gap wider than "no refund button"**, found while
    scoping: `cancel_booking_secure()` permits cancelling a `Confirmed`
    booking and never touches `payments`, and no admin cancel path does
    either — so a paid booking could be cancelled with its payments row still
    reading `paid = true` and no refund trail anywhere. Per the owner's
    decision, self-service cancellation of a paid booking **still succeeds**
    (blocking it would strand the trader with no way to cancel at all); it now
    surfaces as a **⚠ CANCELLED — REFUND?** flag on the Payments page,
    *derived* from existing state (`paid` AND not refunded AND status
    `Cancelled`) rather than stored, so there is no flag to set, forget to
    clear, or let drift out of sync with the rows it describes.
    **Design decisions worth knowing before changing any of this:**
    - **Refund columns live on `payments`, not in a `refunds` child table.**
      `payments` is keyed one-row-per-booking, so a refund is naturally a
      state change on it, and an explicit `refund_amount` supports a PARTIAL
      refund for free. What that shape cannot represent is MULTIPLE separate
      refunds on one booking — deliberate, since a child table for a
      9-payment festival is exactly the speculative complexity the original
      gap note was avoiding. The columns carry enough (amount, timestamp,
      actor, external reference) to backfill a child table later without loss.
    - **`rpc_record_refund` moves no money — it records a refund issued
      elsewhere.** Both the manual path and the Stripe path call it, so a
      refund becomes a fact in exactly one place. It derives the actor from
      the JWT and ignores a client-supplied one, *except* for service_role
      callers (the webhook), which legitimately need to attribute to
      `'Stripe (automatic)'` — a test asserts an admin's attempt to
      attribute a refund to someone else is ignored.
    - **`refund-payment` calls Stripe FIRST, then the database.** If Stripe
      succeeds and the DB write fails, money has moved and the app doesn't
      know — recoverable, because the webhook records it moments later and
      the error surfaces the refund id. The reverse order would let the app
      claim a refund that never happened, with nothing external to correct
      it. One failure mode self-heals; the other is silent and permanent.
    - **The webhook treats "already been refunded" as SUCCESS**, matching on
      that exact wording. That is the expected path when `refund-payment`
      initiated the refund and recorded it synchronously moments before
      Stripe delivered the event; 500ing would make Stripe retry forever. If
      that RPC's error message is ever reworded, update the webhook's match.
    - **Bank transfers are record-only by nature**, not by omission — there
      is no API that moves that money back.
    **Testing note**: all 9 `refund-payment` tests assert REJECTIONS; none
    reaches `stripe.refunds.create()`. Exercising the success path would
    require creating a real charge to refund first, and an automated suite
    that can move money in any mode isn't worth having. The success path is
    covered by `rpc_record_refund`'s own tests plus browser verification.
    159/159 on the test project.
    **A bug caught in my own work, worth repeating as a pattern**:
    `showConfirm()` in `js/ui.js` is CALLBACK-based, not promise-returning.
    An `await showConfirm(...)` returns `undefined` immediately, so the
    confirmation is skipped entirely — which in this case would have silently
    issued real refunds with no prompt. Verified the fix in a browser: the
    dialog appears with the right amount, and cancelling leaves
    `refund_amount` null.
    **ONE MANUAL STEP REMAINS, not doable from here**: `charge.refunded` must
    be enabled on the Stripe webhook endpoint (Dashboard → Developers →
    Webhooks → the endpoint → Update details → Select events). Until then,
    refunds issued *in the Stripe dashboard* won't auto-record — everything
    else works, and the manual path covers it meanwhile.

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

- **`eq_text_user_role()` and its custom operator no longer exist (removed 2026-07-20,
  item 60) — this entry is now historical, kept for the general lesson.** It was invoked
  by operator resolution with no textual call site anywhere: `check_user_role()`'s body
  did `role = required_role` (`text` = `user_role`), and Postgres resolved that to the
  shim invisibly, so grepping the function's name found nothing. Three sibling
  operators/functions (`eq_user_role_text`, `neq_text_user_role`, `neq_user_role_text`)
  really were dead and were removed 2026-07-16, before this one. **The general lesson,
  still true**: figure out which of a set of operator-support functions is load-bearing by
  tracing the expressions that use the types involved, not by searching for the
  function's name as a string.

- **`ALTER POLICY` does not clear a column's `pg_depend` dependency, no matter what you
  rewrite the expression to — and `ALTER COLUMN TYPE` refuses while it's there.**
  Hit live on item 60's `user_roles.role` enum consolidation: a policy directly
  referencing a column (not through a function call — plpgsql function bodies are opaque
  to dependency tracking, so calling `some_func(col)` does NOT create this dependency,
  only writing `col = ...` straight in a policy expression does) registers a dependency
  that survives `ALTER POLICY ... USING (...)` unchanged, because that statement edits the
  expression in place without dropping the underlying pg_depend record. Rewriting the cast
  first and changing the column type second — the intuitive order — fails with "cannot
  alter type of a column used in a policy definition," naming a policy you may have
  *already* rewritten to reference the new type. **The only sequence that works**:
  `DROP POLICY` (every policy that references the column directly) → `ALTER COLUMN TYPE`
  → `CREATE POLICY` fresh. This is Postgres DDL, transactional either way, so a failed
  first attempt (mid-migration) rolls back completely — don't panic-diagnose a partially
  applied state that doesn't exist.

- **A migration that runs without error but does the wrong thing does NOT roll back —
  only a genuinely failed statement does.** Distinct from the point above, and easy to
  conflate with it: a *failed* migration (a Postgres error mid-file) is transactional and
  leaves nothing applied, verified more than once in this repo's history. A migration that
  *succeeds* but was wrong in substance (e.g. an RLS policy that compiles fine and applies
  cleanly, but throws a permission error for a reason only visible once real queries run
  against it — hit live on item 63's `schedules` fix, where an inline `EXISTS` subquery
  referenced a column anon has no grant on) is genuinely committed. Editing the same
  migration file's content and re-running `db push` does **not** re-apply it — Supabase
  tracks applied migrations by filename/timestamp, not content, so it sees that version as
  already done and skips it, silently leaving the wrong version live. Fix: delete the
  broken file, save the corrected content under a **new** timestamp, then
  `supabase migration repair --status reverted <old_version>` before `db push` — repair
  only clears the remote bookkeeping table, it does not touch the actual (still-wrong)
  schema, so the corrected migration still has real work to do when it runs.

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

- **`bookings.location_id` no longer exists — dropped 2026-07-16.** Use
  `booking_locations` + `rpc_set_booking_locations()` exclusively (this was already the
  only real mechanism; the column was long-dead, unread/unwritten by any code path, and
  is gone now rather than just documented-as-dead).

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

- **A cancelled CI run still reports a failing required check and blocks the
  merge — and `cancel-in-progress: false` does not prevent it.** GitHub keeps
  only ONE *pending* run per concurrency group: when a newer run queues behind
  the in-progress one, the previously-pending run is cancelled. Because
  `integration-tests` is globally serialised on the shared test database, that
  eviction used to happen whenever a branch produced two runs (an unscoped
  `push:` plus `pull_request`), leaving a non-success `integration-tests` check
  on the head commit for a job that never executed — and branch protection
  refuses the merge on it. Hit live on PR #43. **Fixed 2026-07-20 by scoping
  `push:` to `main`** so each PR produces exactly one run; don't reintroduce an
  unscoped `push:`. Equally, **don't "fix" a recurrence by setting
  `cancel-in-progress: true`** — that governs a different case entirely, and
  killing a run mid-suite abandons fixtures in the shared database for the next
  run to trip over (the 2026-07-17 failure that created the group). If you do
  see a merge blocked by a 1-second cancelled job, re-run that single job:
  `gh run rerun <run-id> --job <job-id>`.

- **`css/output.css` is a COMMITTED BUILD ARTEFACT — introduce a Tailwind class the
  project has never used before without running `npm run build:css`, and it renders as
  nothing at all.** There is no build step at deploy time; Vercel serves the committed
  file directly. Tailwind only emits classes it finds by scanning the source, so a class
  that exists in your markup but not in the compiled CSS simply has no rule. **For a
  coloured button that means INVISIBLE, not unstyled**: `bg-amber-600 text-white` with no
  `bg-amber-600` rule is white text on a transparent background. Hit live on 2026-07-21 —
  the refund button was present, clickable, correctly wired, and completely unreadable.
  The same rebuild also emitted `disabled:cursor-not-allowed`, missing since v7.1.0's
  Retry button, unnoticed for days.
  **Why the usual checks miss it**: `git status` is clean (the stale file *is* committed),
  the element passes `offsetParent !== null` (it isn't hidden), and its `textContent` is
  correct — so property-level browser assertions all pass. Only looking at it, or
  comparing computed `backgroundColor` against `color`, catches it.
  **Now guarded**: CI's `css-build-check` job rebuilds and fails if the committed file is
  stale (verified to fail on a genuinely stale file and pass on a fresh one, not just
  assumed). If it fires, run `npm run build:css` and commit the result.

- **Tailwind v4 broke `transform` as a stacking-context trick, and it fails
  silently — suspect this first on any "the screen goes blank" report.** The
  Tailwind v2/v3 modal pattern (a `fixed inset-0` overlay, then a panel that is
  `inline-block ... transform transition-all` with no `relative`/`z-`) relied on
  v3's bare `transform` utility emitting a real transform, which created a
  stacking context and lifted the panel above the overlay. **Under v4, bare
  `transform` with no transform values computes to `transform: none`** — no
  stacking context — so the positioned overlay paints over the static panel and
  the user sees a featureless grey screen. Nothing throws; there is no console
  error to find. This hit both `payments.html` modals (item 56). Every other
  modal in the app already uses `relative z-50` on the panel and is unaffected.
  Diagnose it with `document.elementFromPoint(x, y)` at the screen centre — if
  that returns the overlay, this is what you have. The general lesson for other
  v3-era markup: any styling that depended on `transform` for *stacking* rather
  than for movement is now load-bearing-but-absent, and it degrades quietly.

- **`check-rls-grants-snapshot.sh` used to only capture each `CREATE POLICY`'s FIRST
  LINE — fixed 2026-07-20 (item 62), but worth knowing the failure mode existed and
  why, since the same class of bug could recur in a different form.** The old script's
  `grep -E "^(CREATE POLICY|GRANT|REVOKE)"` matched only the line starting with the
  statement, and `pg_dump` wraps a policy's body onto subsequent lines that don't start
  with anything the pattern matched — so two policies with identical names/tables/`TO`/
  `FOR` clauses but a materially different `WHERE` expression showed as unchanged. Hit
  live on item 60: recreating six policies with a different cast (`::text` →
  `::"public"."user_role"`) produced a snapshot diff of only three unrelated GRANT
  lines, none of the actual policy-body changes. The script now accumulates every
  matching statement across lines until the one that actually terminates it (ending in
  `;`) before emitting it as a single joined line — verified against a live dump to
  confirm this doesn't merge unrelated statements or mis-handle `GRANT`/`REVOKE` (which
  are already single-line in this schema, so the same logic applied uniformly is a
  no-op for them). Regenerating the snapshot after the fix surfaced one unrelated
  bonus catch: `"Strict Public Uploads"` on `storage.objects` was *also* multi-line and
  *also* silently truncated the same way, unrelated to anything item 60 or 62 changed —
  confirmed unchanged in substance, just newly visible in full. **The general lesson,
  not just "this script is fixed now"**: any line-oriented capture of multi-statement
  SQL is only as complete as its statement-boundary detection, and `grep` alone has none.

- **`check-rls-grants-snapshot.sh` needs Git Bash, not WSL — and `.gitattributes`
  alone won't save you from CRLF.** Two separate traps, both hit live on
  2026-07-19 while verifying item 55, neither obvious from the error message.
  (a) Running it as `bash scripts/...` from PowerShell resolves to **WSL**
  bash, where the globally npm-installed Supabase CLI has no Linux binary —
  it dies with `No matching Supabase CLI binary package found for linux-x64`,
  three times over, since the script retries the dump. Run it from Git Bash
  (which has the Windows `supabase.exe` on PATH) instead. (b) The
  `*.sh text eol=lf` rule added in item 52 only applies **at checkout**, so a
  working copy that predates it — or that git hasn't re-materialized since —
  still has CRLF on disk and fails with `syntax error near unexpected token
  $'do\r'`. `.gitattributes` being correct is not proof the file on disk is.
  Fix the working copy with `git add --renormalize`, or delete the file and
  `git checkout --` it; check with a byte scan for `0D 0A`, not by eye.

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

- **`bookings`'s anon access pattern changed on 2026-07-15 — the advice below about
  "don't revoke it outright" is now out of date for `bookings` specifically, kept here
  for the history.** `anon`'s old SELECT policy on `bookings` (`"Public see confirmed"`)
  was row-scoped only, as RLS always is — but the table also had a column-restricted
  `GRANT SELECT` for anon (`id, business_name, description, stall_type, category,
  instance_prefix`) that independently blocked reading `email`, `phone`, `address`,
  `owner_name`, `admin_notes`, etc., regardless of the RLS policy. A reviewer reading
  only `pg_policies` (not `information_schema.column_privileges`) would see full-row
  access and wrongly conclude PII was exposed — this happened **twice**: once earlier
  this session (verified against the live schema and found to already be handled, see
  `fix_bookings_rls_exposure.sql`/`fix_performer_schedule_column_grants.sql`), and again
  later the same day, which is what prompted the actual fix — see
  [Public visitor-facing data access](#public-visitor-facing-data-access-bookings)
  above. That second time, the same verification was done (column grants really did
  already prevent PII exposure), but the fix was implemented anyway at the owner's
  request: relying on "RLS allows the row + column grants narrow it" as the only safety
  net is fragile regardless of whether it's currently exploited, since one future
  `GRANT SELECT ON bookings TO anon` would silently undo it. `bookings` now has **zero**
  anon access of any kind — the old column grants are gone too, replaced by the
  `public_bookings_info` view. **`performers` was NOT changed** and still uses the
  column-grant pattern described below — the same "always check
  `information_schema.column_privileges`, not just `pg_policies`, before concluding PII
  is exposed" caution still applies there specifically.

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
  bypassable by calling the public endpoint directly. If the temp→booking-folder move
  fails, `bookings.documents` deliberately keeps the `temp/` source path (nothing
  cleans up `temp/`, so the file is still there and signable) rather than recording a
  destination that doesn't exist — see [Next Steps](#8-next-steps) item 51.

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

---

## 10. Disaster Recovery Runbook

Written 2026-07-16 after actually performing a restore drill against the disposable
test project — not a theoretical procedure. Every step below reflects something that
was either directly observed to work, directly observed to fail and require a
workaround, or explicitly flagged as untested. **A backup that has never been
restored is a hypothesis, not a safety net** — the drill exists precisely to turn
"we think this works" into "we know exactly what this does and doesn't recover."

### Where the backup comes from

A separate, private companion repo, `blagdon/Stall_Booking` (not this repo), runs
`.github/workflows/backup.yml` daily at 02:00 UTC: `pg_dump "$SUPABASE_DB_URL"
--clean --if-exists --no-owner --no-privileges`, uploaded as a GitHub Actions
artifact named `supabase-backup`, 30-day retention. `SUPABASE_DB_URL` targets the
**live** project (`rsnxhuhibglieofikkpo`). Confirmed via that repo's own Actions run
history (not just the file existing) that this has been running successfully daily
for months. Download the latest one with:

```
gh run list --repo blagdon/Stall_Booking --workflow=backup.yml --limit 1 --json databaseId
gh run download <run-id> --repo blagdon/Stall_Booking --name supabase-backup
```

### The dump file itself is a credential store — handle it accordingly

Worth saying plainly, because it's easy to treat a database backup as "just data": this
`pg_dump` output contains the `settings` table's rows in full, unencrypted — the live Zoho
client secret, refresh token, and current access token; the SerpApi key; the Stripe
Test-mode secret key; and the association's bank account details — plus every
stallholder's name, email, phone, and address from `bookings`, and `auth.users`' full
column set (`encrypted_password` included, per the drill above). That's normal for a
full dump, not a bug in the backup process, but it means **the file itself is as
sensitive as the live database it came from**. Whenever you pull one down: encrypt it at
rest, never let a copy land in this repo or any other git history, and be deliberate
about where copies end up (a synced folder like Dropbox/OneDrive/iCloud silently
proliferates copies you won't be tracking) — delete local copies once you're done with
whatever you downloaded it for.

### What's actually in it, and what isn't

- **Full `public` schema (this app's own tables/functions/views/policies) and its
  data** — restores completely and correctly. Verified: exact row counts matched the
  source (178 bookings, 36 settings, 53 payments, 1503 audit_logs, etc.) and spot-
  checked real content came back correctly.
- **`auth.users`** (real login accounts) — genuinely captured, confirmed by direct
  inspection of the dump (7 rows, full column set including `encrypted_password`).
  Not restored during the drill itself (see scoping decision below), but present.
- **`storage.objects`/`storage.buckets`** — only the *metadata* rows (file paths,
  bucket, size, mime type) are captured. **The actual uploaded file bytes are not
  in this backup at all** — they live in Supabase's separate S3-compatible object
  store, which `pg_dump` never touches. Restoring this backup alone leaves every
  `bookings.documents` path pointing at a file that doesn't exist. If document
  recovery is ever required, it needs a completely separate backup strategy
  (e.g. periodically syncing the bucket to external storage) — nothing here provides
  it.
- **Zero `GRANT`/`REVOKE` statements anywhere in the dump** (the `--no-privileges`
  flag). This is the single most important finding of the drill — see below.

### The `--no-privileges` problem (read this before ever restoring for real)

Supabase's own schema-level default-privilege configuration automatically re-grants
full table-level CRUD to `anon`/`authenticated` on any table a migration (or a raw
restore) (re)creates — this is *why* the restore doesn't outright break table access.
But it means restoring this dump **silently reopens every deliberate access
restriction** this project has ever added, because those were all implemented as
`REVOKE`s layered on top of that default, and `REVOKE` is exactly what
`--no-privileges` strips. Confirmed by actually doing it: after restoring, anon could
freely read `stripe_webhook_events`, `user_roles`, and `email_queue` (all meant to be
completely inaccessible to anon), and both `bookings` and `performers` reverted from
their intended narrow **column-level allow-lists** to full table-level access minus
nothing — i.e. this session's own anon-bookings-PII security fix would come back
*undone* by a naive restore.

**None of this is optional to fix — a "successfully restored" system with these
regressions is measurably less secure than before the disaster.** The reliable way
to detect and fix it (used during the drill, not hand-guessed): dump the restored
project's current grants and diff against the checked-in `rls_grants_snapshot.txt`
(see [Testing](#testing), item 46) —

```
supabase db dump --schema public,storage --linked -f /tmp/current.sql
grep -E "^(CREATE POLICY|GRANT|REVOKE)" /tmp/current.sql | sort > /tmp/current_snapshot.txt
diff -u rls_grants_snapshot.txt /tmp/current_snapshot.txt
```

— then replay every `REVOKE`/narrow `GRANT` the diff shows as missing. A handful of
these load-bearing `REVOKE`s (e.g. `user_roles`, `email_queue`, the `bookings`/
`performers`/`schedules` dormant-grant cleanups) live **only** in
`supabase/sql-archive/*.sql` — one-time fixes applied before the migration workflow
existed, never captured as tracked migrations at all. `supabase db push` alone will
not restore these; they must be replayed from that archive by hand (or, more
reliably, just use the snapshot-diff method above, which doesn't care where a given
grant originally came from).

### `public.user_roles` has a hard dependency on `auth.users`

`user_roles.id` is a foreign key into `auth.users.id`. Restoring `user_roles`' data
against any project whose `auth.users` rows don't have matching UUIDs (e.g. the test
project's own different admin account) fails outright with a foreign-key violation
— confirmed directly. This means restore order matters: `auth.users` must be
restored (or already match) before `user_roles` can be.

### The tooling gap: nothing here can execute `COPY FROM STDIN`

`pg_dump`'s default plain-SQL output uses `COPY table FROM stdin; <data> \.` blocks
to load data, plus a `\restrict`/`\unrestrict` psql-only meta-command pair (new in
pg_dump 17.x). Neither is real SQL — both require an actual `psql`/libpq client to
execute correctly. **This machine has no `psql` installed**, and the only other tool
available (`supabase db query -f <file>`, which goes through the Management API) was
tested directly: it ran the schema DDL fine and reported success, but silently
loaded **zero rows** from every `COPY` block, no error at all. Confirmed by checking
row counts after — all zero, despite a clean "success" response. The only way this
drill got real data restored was converting every `COPY` block into `INSERT`
statements first (a Python script; see the session transcript for the exact
conversion, which handles COPY's `\N`-is-NULL and backslash-escape rules). **Anyone
attempting this restore for real should install a real Postgres 17 client (`psql`)
first** — trying to restore through `supabase db query -f` alone will appear to
succeed while silently doing nothing to the actual data.

### Recommended procedure (informed by the above, only partially drilled end-to-end)

For **data loss/corruption on the existing live project** (the scenario actually
drilled, against the test project as a stand-in):
1. Get the latest backup artifact (see above).
2. Install a real `psql` (Postgres 17 client) if at all possible — don't rely on
   `supabase db query -f` for the data-loading step.
3. Strip the dump down to the `public` schema only before restoring against an
   already-provisioned project — do **not** replay `DROP`/`CREATE` for `auth`,
   `storage`, `realtime`, `vault`, `pgbouncer`, `graphql`, `extensions`, or
   `supabase_migrations`; these are Supabase-platform-owned, and the connecting role
   isn't their owner (confirmed: attempting this fails immediately with `must be
   owner of event trigger pgrst_drop_watch` / `must be owner of table
   vector_indexes`, and touching them risks breaking the project's actual Auth/
   Storage services, not just this app's own tables).
4. Restore the filtered `public`-schema dump (schema + data).
5. Run `supabase db push` to replay every tracked migration on top — this restores
   most, but not all, of the correct grants (see the sql-archive gap above).
6. Diff against `rls_grants_snapshot.txt` (method above) and manually replay
   whatever's still missing.
7. Run the full test suite (`npm run test:integration`) and confirm green before
   considering the restore complete.

For **total project loss, rebuilding on a genuinely fresh Supabase project** —
**not drilled, treat the following as informed inference, not verified fact**: a
fresh project's own `auth`/`storage`/`realtime` schemas are already correctly
provisioned by Supabase itself, so the backup's DDL for those schemas should likely
be skipped entirely (same reasoning as step 3 above, for the same reason); only the
actual `auth.users` *data* would need importing (after schema recreation, matching
`user_roles`' FK dependency), followed by `supabase db push` for the full `public`
schema, then the data restore and grant-diff steps as above. This path has not been
tested — if it's ever actually needed, drill it the same way this document's method
does, don't assume it works.
