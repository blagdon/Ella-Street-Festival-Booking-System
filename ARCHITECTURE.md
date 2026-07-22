# Ella Street Festival — Booking System Architecture

> **Audience:** Developers maintaining or extending this system.
> **Reflects:** v7.11.0
> **Last verified against the code:** 22 July 2026

> **Where this sits among the docs**
> - **`ARCHITECTURE.md`** (this file) — the shape of the system: what exists, how the pieces fit, where to look.
> - **`HANDOVER.md`** — the deep reference and the authority when the two disagree. Every non-obvious behaviour, past incident and "Gotcha" is written up there in detail. It is long; use its table of contents.
> - **`CHANGELOG.md`** — what changed and when.
> - **`USER_GUIDE.md`** — how to *operate* the system, for festival organisers rather than developers.
>
> Keep this file at the level of "what exists and why" — behaviour that needs a paragraph of caveats belongs in HANDOVER.md, linked from here.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Tech Stack](#2-tech-stack)
3. [Repository Structure](#3-repository-structure)
4. [Instances & Data Separation](#4-instances--data-separation)
5. [Authentication & Roles](#5-authentication--roles)
6. [Module Architecture (JS)](#6-module-architecture-js)
7. [Page Catalogue](#7-page-catalogue)
8. [Edge Functions](#8-edge-functions)
9. [Database Schema (Supabase)](#9-database-schema-supabase)
10. [Email System](#10-email-system)
11. [Payments & Refunds](#11-payments--refunds)
12. [Public Booking Forms](#12-public-booking-forms)
13. [Configuration & Settings](#13-configuration--settings)
14. [Deployment](#14-deployment)
15. [Testing & CI](#15-testing--ci)
16. [Common Maintenance Tasks](#16-common-maintenance-tasks)

---

## 1. System Overview

The **Ella Street Festival stall booking system** — a public application form for traders plus an admin panel for organisers, covering the whole life of a booking from submission to a paid, located stall.

### High-level flow

```
Public Trader                              Admin Team
─────────────                              ──────────
Fills in booking form            ──►  Booking appears on the Kanban board
(Food / General)                          │
   │                                      ▼
   ▼                              Admin reviews, sets status
"Application received" email              │
(auto, via submit-booking)                ▼
                                  ┌───────┴────────┐
                                  ▼                ▼
                          Payment Requested    Confirmed (free)
                          (Stripe Checkout      or Rejected
                           link emailed)            │
                                  │                 │
                                  ▼                 │
                          Trader pays ──► webhook   │
                          finalises payment,        │
                          books to Confirmed        │
                                  └────────┬────────┘
                                           ▼
                                  Admin assigns pitch(es)
                                  → location email sent
                                           ▼
                                  Refunds/cancellations as needed
```

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Vanilla HTML + JavaScript (ES Modules), no framework |
| **Styling** | Tailwind CSS v4 (`@tailwindcss/cli`), compiled to `css/output.css` and **committed** |
| **Database / Auth** | Supabase (PostgreSQL + Row Level Security + Supabase Auth) |
| **File Storage** | Supabase Storage, private bucket (default `esf-documents`) |
| **Server-side logic** | Supabase Edge Functions (Deno / TypeScript) |
| **Email Delivery** | Zoho Mail API, called from Edge Functions |
| **Payments** | Stripe Checkout + Stripe webhooks; bank transfer recorded manually |
| **Hosting** | Vercel — `https://app.ellastreet.co.uk` |
| **Scheduled jobs** | Vercel Cron → `api/ping.js` (Supabase keep-alive) |
| **Bot Protection** | Cloudflare Turnstile (public forms) |
| **Map** | Leaflet.js |

---

## 3. Repository Structure

```
/
├── index.html                  ← Admin hub (requires login)
├── login.html                  ← Admin login
├── kanban_m.html               ← Kanban board (main workflow view)
├── summary.html                ← List/table view with detail pane
├── payments.html               ← Payments, bank transfers, refunds
├── stats.html                  ← Statistics/charts
├── location_admin.html         ← Assign bookings to pitches
├── visitor_map.html            ← Leaflet map of stall locations
├── hcc_dashboard.html          ← HCC council food-safety checks
├── more.html                   ← Admin tools index
├── settings.html               ← System settings (see §13)
├── booking_forms.html          ← Booking form links/status
├── update_details.html         ← Edit an individual booking
├── add_misc.html               ← Add a misc facility (barriers, first aid…)
├── email_admin.html            ← Email template management
├── email_queue.html            ← Email queue viewer + retry
├── audit_log.html              ← Audit log viewer
├── manage_users.html           ← Manage admin/steward roles
├── steward.html                ← Offline-capable steward app
├── steward_login.html          ← Steward login
├── sw.js / manifest.json       ← Service worker + PWA manifest (steward app only)
│
├── General_Booking.html        ← PUBLIC: general/non-food application
├── Food_Stall_booking.html     ← PUBLIC: food stall application
├── cancel_booking.html         ← PUBLIC: self-service cancellation
├── payment_success.html        ← PUBLIC: Stripe success return page
├── payment_cancelled.html      ← PUBLIC: Stripe cancel return page
│
├── supabase-public.js          ← ⭐ Single source of truth for public config
├── email_templates.js          ← Legacy fallback templates (DB is primary)
│
├── api/
│   └── ping.js                 ← Vercel Cron keep-alive endpoint
│
├── css/
│   ├── input.css               ← Tailwind source
│   └── output.css              ← Compiled Tailwind — COMMITTED build artefact
│
├── js/                         ← Admin/public JavaScript modules (ES modules)
│   ├── package.json            ← Marks js/ as ESM for Node tooling only
│   ├── config.js               ← Derived config constants
│   ├── supabase.js             ← Client + requireAuth/initAdminPage
│   ├── api.js                  ← Database operations (CRUD + audit)
│   ├── shared.js               ← Cross-page business logic
│   ├── utils.js                ← Validation, escaping, safe errors
│   ├── ui.js                   ← Toasts and UI helpers
│   ├── nav.js                  ← Injected navigation header
│   ├── kanban.js / summary.js / payments.js / stats.js / locations.js /
│   │   map.js / details.js     ← Feature modules
│   ├── fsa-ratings.js          ← FSA food-hygiene lookup (detail pane)
│   ├── google-reviews.js       ← Google reviews lookup (detail pane)
│   ├── stripe-credentials.js   ← Stripe settings save rule
│   ├── page-*.js               ← Entry point per HTML page
│   └── vendor/supabase.js      ← Vendored Supabase browser SDK
│
├── supabase/
│   ├── functions/              ← Edge Functions (see §8)
│   │   └── _shared/            ← zoho.ts, stripe.ts, cors.ts, bucket.ts, format.ts, errors.ts
│   ├── migrations/             ← Ordered SQL migrations
│   └── config.toml
│
├── scripts/                    ← Guards, dev server, test seeding
├── tests/                      ← Node test runner suites (see §15)
├── .githooks/pre-commit        ← Guards mirrored in CI
├── schema.sql                  ← Full schema dump (reference)
└── rls_grants_snapshot.txt     ← Committed RLS/grants snapshot, checked in CI
```

> There is **no `GAS/` folder**. The old Google Apps Script keep-alive was replaced by `api/ping.js` driven by Vercel Cron — see §14.

---

## 4. Instances & Data Separation

Multiple booking types live in one database, separated by an `instance_prefix` column on every booking.

| Instance Key | Prefix | Description |
|---|---|---|
| `DEV` | `ESF26-DEV-` | Test/development data (always uses Stripe **Test** mode) |
| `FOOD` | `ESF26-FOOD-` | Food stall applications |
| `GENERAL` | `ESF26-NONFOOD-` | General/non-food trader applications |
| `MISC` | `ESF26-MISC-` | Non-bookable facilities (barriers, first aid…) |

The `ESF26` part is **not hardcoded** — it comes from the `booking_prefix` setting (falling back to `ESF26`), so the festival year can be rolled over without a code change.

The active instance is stored in `localStorage` under `ESF_INSTANCE`; the nav header switches it and reloads.

> **Key rule:** booking IDs are `{PREFIX}-{TYPE}-{NNNN}` (e.g. `ESF26-FOOD-0042`), enforced by `utils.js → validateBookingId()`. IDs are allocated server-side by the `get_next_booking_id` RPC, with retry-on-conflict in `submit-booking` — see that function's comments for why the lock alone isn't enough.

---

## 5. Authentication & Roles

Supabase Auth (email + password). Roles live in `user_roles`, typed by the `user_role` enum:

| Role | Access |
|---|---|
| `admin` | All admin pages |
| `steward` | `steward.html` |

### How auth works

1. Admin pages load `js/page-*.js`, which calls `initAdminPage(callback)` from `supabase.js`.
2. That calls `requireAuth(requiredRole = 'admin')`: checks the session, then reads `user_roles`.
3. Access is granted if the user's role is `admin` **or** matches `requiredRole` — so an admin can also use steward pages, but not vice versa.
4. Not logged in → redirected to `login.html` (or `steward_login.html` for steward pages).
5. Wrong role → same page with `?error=unauthorized`.

`requireAuth()` also loads the settings-driven config (`loadStallCosts`) before the page renders, which is why costs and stall types are available synchronously afterwards.

### Public pages
`General_Booking.html`, `Food_Stall_booking.html`, `cancel_booking.html` and the two Stripe return pages need no session. Their entry scripts use `initPublicPage()` / `getPublicSupabaseClient()` from **`supabase-public.js`** (not `js/supabase.js`).

### Audit logging
Significant admin actions are written to `audit_logs` via `api.js → auditLog()`, and viewable at `audit_log.html`.

---

## 6. Module Architecture (JS)

```
supabase-public.js   (public config + public client — top of the tree)
    ↑
config.js            (imports ESF_PUBLIC_CONFIG)
    ↑
utils.js  /  ui.js   (validation, escaping / toasts)
    ↑
supabase.js          (client, requireAuth, initAdminPage)
    ↑
api.js               (all DB reads/writes, audit logging)
    ↑
shared.js            (cross-page business logic)
    ↑
[feature modules]    (kanban.js, summary.js, payments.js, locations.js, …)
    ↑
page-*.js            (entry points — one per HTML page)
```

| File | Purpose |
|---|---|
| `supabase-public.js` | **Single source of truth for public configuration** — Supabase URL/anon key, base/cancel/portal URLs, Turnstile site key, booking prefix. Also provides the public client and `initPublicPage()`. |
| `config.js` | Derives `CONFIG` from `ESF_PUBLIC_CONFIG` plus the settings table: instance map, status list/colours, stall costs, allowed types. Contains **no hardcoded prices or bank details**. |
| `supabase.js` | Creates/caches the admin client; `requireAuth()`; `initAdminPage()`; `signOut()`. |
| `api.js` | All direct database access. Validates input, audit-logs mutations. |
| `shared.js` | Status-change workflow, email template rendering, detail pane population. |
| `utils.js` | `escapeHtml`, `sanitizeUrl`, `validateString/Email/BookingId/Status`, `safeError` (strips DB internals out of user-facing errors). |
| `ui.js` | `showToast()`. |
| `nav.js` | `initNavigation()` — injects the header, instance switcher, sign-out. |
| `stripe-credentials.js` | The rule for which Stripe credential rows a settings save writes. Deliberately import-free so it is unit-testable. |
| `page-*.js` | Entry point per page. |

> **XSS rule:** anything interpolated into `innerHTML` must go through `escapeHtml()`. This is enforced by `scripts/check-unescaped-innerhtml.mjs`, which runs in the pre-commit hook *and* CI — it exists because of four real XSS gaps. Note it only scans files ending in `.js`.

---

## 7. Page Catalogue

### Admin pages (require login)

| Page | Entry script | Purpose |
|---|---|---|
| Hub | `page-index.js` | Landing page linking all modules |
| Kanban Board | `page-kanban.js` | Drag-and-drop workflow by status |
| List View | `page-summary.js` | Searchable table + slide-in detail pane |
| Location Manager | `page-location-admin.js` | Assign bookings to pitches |
| Payments | `page-payments.js` | Stripe + bank transfer, refunds, CSV export |
| Statistics | `page-stats.js` | Charts and revenue (from real prices) |
| Visitor Map | `page-visitor-map.js` | Leaflet map of stall locations |
| HCC Dashboard | `page-hcc-dashboard.js` | Council food-safety check tracking |
| More | `page-more.js` | Index of admin tools |
| Settings | `page-settings.js` | System settings (§13) |
| Booking Forms | `page-booking-forms.js` | Form links and open/closed status |
| Update Details | `page-update-details.js` | Edit one booking |
| Add Misc | `page-add-misc.js` | Add a non-bookable facility |
| Email Admin | `page-email-admin.js` | Manage email templates |
| Email Queue | `page-email-queue.js` | View sent/failed emails, retry |
| Audit Log | `page-audit-log.js` | Browse the audit trail |
| Manage Users | `page-manage-users.js` | Assign admin/steward roles |
| Steward App | `page-steward.js` | **Offline-capable** — works from `localStorage` with a sync queue, for on-site use with poor signal. The only page using `sw.js`/`manifest.json` (installable as a PWA) |

### Public pages (no login)

| Page | Purpose |
|---|---|
| `General_Booking.html` | General/non-food application |
| `Food_Stall_booking.html` | Food stall application |
| `cancel_booking.html` | Self-cancellation via `cancel_token` link |
| `payment_success.html` / `payment_cancelled.html` | Stripe Checkout return pages |

---

## 8. Edge Functions

All under `supabase/functions/`. Shared helpers live in `_shared/`.

| Function | Auth | Purpose |
|---|---|---|
| `submit-booking` | Public (Turnstile) | Validates the CAPTCHA, builds a booking row from an **allow-list** of fields, allocates the ID, moves uploaded files into the booking's folder, sends the "received" email |
| `cancel-booking` | Public — Turnstile **and** `cancel_token` | Self-service cancellation (via `cancel_booking_secure`) + confirmation email |
| `create-checkout-session` | Admin JWT | Creates a Stripe Checkout Session, emails the payment request, moves the booking to `Payment Requested` |
| `stripe-webhook` | Stripe signature | Finalises payments, records refunds (§11) |
| `refund-payment` | Admin JWT | Issues a real Stripe refund, then records it |
| `send-email` | Admin JWT | Single-email send path |
| `queue-bulk-email` | Admin JWT | Drains `email_queue` in the background |
| `retry-queued-email` | Admin JWT | Re-sends one failed `email_queue` row |
| `get-booking-documents` | Admin JWT | Signs private-bucket document paths into time-limited URLs |
| `get-reviews` | Admin JWT | Google reviews lookup, cached in `google_reviews_cache` |

> Only `submit-booking` and `cancel-booking` are reachable without an admin session, and both sit behind Turnstile. Everything else verifies the JWT **and** re-checks the `admin` role against `user_roles` — the role check is not inherited from the gateway.

> **Never call one Edge Function from another over HTTP.** Put shared logic in `_shared/` and call it in-process. This pattern caused three production bugs in one session; `.githooks/pre-commit` greps for `functions.invoke(` under `supabase/functions/` and fails the commit. See HANDOVER.md's sibling-function Gotcha.

> **CORS** is centralised in `_shared/cors.ts` as a single production origin. It is a browser-side protection, not an auth boundary — local dev has no fixed origin and therefore loses browser CORS access to these functions by design.

---

## 9. Database Schema (Supabase)

### Tables

| Table | Purpose |
|---|---|
| `bookings` | The main table — every application, separated by `instance_prefix` |
| `payments` | Payment/refund state, one row per paid booking |
| `booking_locations` | **Join table** mapping bookings → pitches (a booking may hold several) |
| `locations` | Reference data for physical pitches |
| `email_queue` | Log of every email sent or failed |
| `email_templates` | HTML templates, editable in the admin UI |
| `audit_logs` | Admin action trail |
| `hcc_checks` | Council food-safety check entries |
| `user_roles` | Role per Supabase Auth user (`admin` / `steward`) |
| `settings` | Key/value runtime configuration (§13) |
| `stripe_webhook_events` | Processed Stripe event ledger — the email-send idempotency boundary |
| `google_reviews_cache` | Cached Google reviews lookups |
| `performers`, `schedules` | **Owned by a separate application** — see below |

### Enums

`user_role` (`admin`, `steward`) · `booking_fee_type` (`Commercial`, `Charity`, `Not for profit`) · `performance_type` · `performer_status`

### `bookings` — selected columns

`id` · `instance_prefix` · `status` · `business_name` · `registered_business_name` · `owner_name` · `email` · `phone` · `address` · `website` · `category` · `stall_type` · `description` · `other_requirements` · `docs_checklist` · `power_required` · `is_resident` · `is_charity` · `documents` · `cancel_token` · `stall_cost` · `admin_notes` · `rejection_reason` · `created_at` · `date_confirmed` · `stripe_checkout_session_id` · `stripe_payment_intent_id` · `stripe_payment_requested_at`

`website` is optional, free text (a URL or social-media handle), collected on the public Food/General forms and the admin "Add Misc" form. Rendered as a link only via `utils.js → sanitizeUrl()` — never trusted as a raw `href`, since it accepts arbitrary public input.

> There is **no `bookings.location_id`** — it was dropped once a booking could hold multiple pitches. Locations are read/written through `booking_locations` and the `rpc_set_booking_locations` RPC, which also guards against two admins claiming the same pitch concurrently.

### Statuses

`Pending` · `Payment Requested` · `Confirmed` · `Rejected` · `Cancelled` · `HCC Checks`

> `On Hold` no longer exists — it was removed by migration. `Payment Requested` was added with Stripe.

### Key RPCs

| RPC | Purpose |
|---|---|
| `get_next_booking_id` | Allocates the next sequential booking ID |
| `rpc_get_next_misc_id` | Same, for misc facilities |
| `finalize_stripe_payment` | Atomic status change + payments upsert on successful payment |
| `rpc_record_bank_transfer_payment` | Records a manual bank transfer |
| `rpc_record_refund` | Records a refund (rejects a double refund) |
| `rpc_set_booking_locations` | Sets a booking's pitches, race-safe |
| `cancel_booking_secure` | Token-authenticated public cancellation |
| `claim_pending_emails` | Lets the bulk drainer claim queue rows |

### Row Level Security

RLS is the **only** thing protecting the database — the anon key is public by design. Policies and grants are captured in `rls_grants_snapshot.txt` and diffed against the live project on every CI run, so an unintended policy change fails the build.

> The snapshot is authoritative **from the production project only**. See HANDOVER.md before regenerating it.

### The performers/schedules subsystem

`performers` and `schedules` are in this database but are **managed by a separate external application**, linked from `more.html`. No code in this repo reads or writes them. This repo's responsibility for them is limited to their RLS scoping — `tests/schedules-anon-scope.test.mjs` proves anon can only see slots belonging to approved performers. Don't assume a schema change here is safe for that other app.

---

## 10. Email System

```
Trigger (admin action, or an Edge Function)
        │
        ▼
_shared/zoho.ts → sendViaZoho()   ← called IN-PROCESS, never over HTTP
        │
        ├── Zoho Mail API
        └── row written to email_queue (status: Sent / Error)
```

Templates live in the `email_templates` table and are edited at `email_admin.html`. `email_templates.js` in the repo root is a legacy fallback only.

Each Edge Function does its own placeholder substitution rather than sharing one renderer — a deliberate, documented choice.

Supported placeholders: `{{owner_name}}` `{{business_name}}` `{{booking_id}}` `{{cancel_link}}` `{{cost}}` `{{bank_details}}` `{{location_id}}` `{{reason}}` (plus the individual bank fields for the payment-request template).

| Trigger | Template |
|---|---|
| Booking submitted | `application_received` |
| Payment requested | `payment_requested` |
| Confirmed (chargeable) — incl. after Stripe payment | `confirmed_chargeable` |
| Confirmed (free) | `confirmed_free` |
| Rejected | `rejected` |
| Self-service cancellation | `cancellation_confirmed` |
| Location assigned | `location_update` |
| Payment reminder | `payment_reminder` |
| HCC batch check submission | `hcc_batch_check` |

> Values interpolated into emails are HTML-escaped. A failed email must never fail the action that triggered it — sends are best-effort and logged, and `email_queue.html` offers a retry.

---

## 11. Payments & Refunds

Two payment methods, deliberately asymmetric:

**Stripe** — admin clicks *Request Payment* → `create-checkout-session` creates a Checkout Session, emails the link, and moves the booking to `Payment Requested`. When the trader pays, `stripe-webhook` receives `checkout.session.completed` and calls `finalize_stripe_payment` (one atomic transaction: status → `Confirmed`, plus the `payments` row), then sends the confirmation email once, guarded by the `stripe_webhook_events` ledger.

**Bank transfer** — no API exists, so the money moves when a human moves it. Admins record it via `rpc_record_bank_transfer_payment` on the Payments page.

### Refunds

`refund-payment` (admin JWT, Stripe only) calls Stripe **first**, then records the result. That order is deliberate: a Stripe-succeeded/DB-failed state self-heals via the webhook, whereas the reverse would have the app claiming a refund that never happened. Bank transfers stay record-only.

`stripe-webhook` also handles `charge.refunded`, which is what catches refunds issued directly in the Stripe dashboard. Getting the real refund id there needs an extra API call — read the comments before touching it.

### Test vs Live mode

Both modes' credentials live in the `settings` table. DEV-instance bookings always use Test mode; the `stripe_test_mode` setting forces Test mode for Food/General too, for a full rehearsal before going live. The webhook tries both signing secrets and remembers which one verified, so follow-up API calls hit the right Stripe account.

---

## 12. Public Booking Forms

- Non-module scripts loading `supabase-public.js`; Cloudflare Turnstile for bot protection.
- Submissions go through the **`submit-booking` Edge Function**, not a direct client insert.
- Uploads land in a private Supabase Storage bucket; admin views resolve them to signed URLs via `get-booking-documents`.
- Forms can be opened/closed at runtime via the `food_bookings_open` / `general_bookings_open` settings.

> ⚠️ The anon key is intentionally public. Security is enforced entirely by **RLS**, not by hiding the key.
>
> ⚠️ Turnstile proves *a human made a request* — not that the request body matches what the form would have sent. `submit-booking` therefore builds its insert from an explicit field allow-list and re-validates filenames server-side. Never insert a public request body as-is.

---

## 13. Configuration & Settings

Configuration lives in three places, in order of authority:

**1. `settings` table (runtime, admin-editable)** — the primary source for anything operational: stall costs, allowed stall types, bank details, Stripe and Zoho credentials, base/cancel URLs, booking prefix, bucket name, map centre, form open/closed flags, festival display name. Edited at `settings.html`; no redeploy needed.

**2. `supabase-public.js` (repo)** — the **single source of truth for public/bootstrap config**: Supabase URL and anon key, base/cancel/portal URLs, Turnstile site key, booking prefix. It configures **both** the public pages and, via `js/config.js`, the admin dashboard.

> ⚠️ Changing the Supabase project here repoints the **entire application**. This has caused a real outage — see HANDOVER.md.

**3. `js/config.js` (derived)** — imports `ESF_PUBLIC_CONFIG` and layers the settings table on top. It holds **no** hardcoded prices or bank details; `getStallCost()` reads from settings and falls back to 0 with a console warning.

Anon can read only an **allow-listed subset** of settings keys — credentials are not in that list.

---

## 14. Deployment

Vercel, deployed automatically on push. Production: `https://app.ellastreet.co.uk`.

### css/output.css is a committed build artefact

There is **no build step at deploy time** — Vercel serves the committed file. Tailwind only emits classes it finds in the source, so adding a class the project has never used and forgetting to rebuild ships markup referencing CSS that doesn't exist.

That failure is **silent and can be invisible rather than merely unstyled** — a coloured button with no background rule renders as white text on nothing. CI rebuilds and diffs to catch it; `git status` won't, because the stale file is committed and therefore clean.

```bash
npm run build:css
```

### Keeping Supabase awake

`api/ping.js`, invoked by Vercel Cron (schedule in `vercel.json`), queries `locations` to reset the free-tier inactivity timer. It queries `locations` rather than `bookings` because anon lost direct `bookings` access in a security fix. Protected by `CRON_SECRET`.

---

## 15. Testing & CI

### Guards (`.githooks/pre-commit`, also run in CI)

1. **Sibling-function HTTP calls** — greps for `functions.invoke(` under `supabase/functions/`.
2. **Unescaped `innerHTML`** — `scripts/check-unescaped-innerhtml.mjs`.

Both run in CI too, because a local hook can be bypassed.

### CI jobs (`.github/workflows/ci.yml`)

| Job | What it does |
|---|---|
| `grep-guard` | Runs the pre-commit guards |
| `css-build-check` | Rebuilds Tailwind and fails if the committed CSS is stale |
| `rls-grants-check` | Read-only schema dump vs `rls_grants_snapshot.txt` |
| `integration-tests` | The `tests/` suites against the disposable test project |

`push` is scoped to `main` deliberately — an unscoped trigger produced duplicate runs that interacted badly with the concurrency group and blocked merges. **Pushing a branch with no PR runs no CI; open the PR.**

### Tests

Everything in `tests/` runs against the **disposable test Supabase project only**; every file hard-refuses to run against anything else. Seed fixtures first:

```bash
npm run test:setup
npm run test:integration
```

`integration-tests` uses a global concurrency group because all runs share that one project — two at once corrupt each other's fixtures. **A local run can clash with a CI run** for the same reason.

Most suites are integration tests needing credentials in `.env.test`. Pure unit tests (e.g. `stripe-credentials-save.test.mjs`) need none and run anywhere.

---

## 16. Common Maintenance Tasks

### Change stall prices, bank details, or allowed stall types
`settings.html`. No code change — there are no hardcoded defaults.

### Change the Vercel/production URL
Update `base_url`, `cancel_url` and `portal_url` in the `settings` table, and the matching values in `supabase-public.js` (the bootstrap fallback). Also update `ALLOWED_ORIGIN` in `supabase/functions/_shared/cors.ts` and redeploy the functions, or browser calls will fail CORS.

### Rotate the Supabase anon key
Update `supabase-public.js` and redeploy. Remember it configures the admin dashboard too.

### Rotate Stripe or Zoho credentials
`settings.html`. No redeploy.

### Add an admin user
The user needs a Supabase Auth account first, then assign the role at `manage_users.html`.

### Add an email template
Insert a row in `email_templates` with a unique `id`, then render it with the placeholders in §10.

### Add a booking status
1. Add it to `CONFIG.UI.STATUS_LIST` and `STATUS_COLORS` in `config.js`
2. Check `utils.js → validateStatus()` accepts it (it reads the same list)
3. Add a Kanban column in `kanban.js` if it needs one
4. Consider the RLS policies and any status-guarded RPC

### Regenerate the RLS snapshot
Only from the production project, and relink afterwards. Read HANDOVER.md first — the test project has known drift.

---

*Deeper behavioural detail, incident write-ups and gotchas live in `HANDOVER.md`. Inline JSDoc in `js/` and the Edge Function docstrings are unusually detailed and are worth reading before changing anything — most of them exist because something broke.*
