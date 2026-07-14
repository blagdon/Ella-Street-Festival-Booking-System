# HANDOVER — Ella Street Festival Booking System

> Written for an AI coding agent picking this up cold. No prior context assumed.
> Last updated: 2026-07-14, at the end of a long security/reliability hardening session.
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
├── *.html                       ← One file per page, repo root = deploy root
├── js/                          ← Admin JS modules (ES modules)
├── css/input.css, output.css    ← Tailwind source / compiled output
├── api/ping.js                  ← Vercel serverless fn — Supabase keep-alive cron
├── supabase/
│   ├── config.toml              ← Local Supabase dev config (Postgres 17)
│   └── functions/
│       ├── _shared/zoho.ts      ← Shared Zoho OAuth+send logic
│       ├── _shared/bucket.ts    ← Shared document-bucket-name resolver
│       ├── submit-booking/      ← Public: create a booking
│       ├── cancel-booking/      ← Public: self-service cancellation
│       ├── send-email/          ← Single choke point for all outbound email
│       ├── queue-bulk-email/    ← Admin: bulk-email confirmed bookings
│       ├── get-reviews/         ← Admin: Google Maps review lookup (SerpApi)
│       └── get-booking-documents/ ← Admin: sign document storage paths for viewing
├── supabase-public.js           ← Credentials + config for PUBLIC pages (non-module)
├── email_templates.js           ← LEGACY fallback templates (real ones are in the DB)
├── vercel.json                  ← Vercel Cron config
└── *.sql                        ← One-shot manual migration/fix scripts (see below)
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
| `submit-booking` | None (`--no-verify-jwt`) | Only path for creating a public booking. Rebuilds the row from an explicit allow-list (`sanitizeBookingInput()`) rather than trusting the request body — mass-assignment protection. Sends the "received" auto-email itself (`sendReceivedEmail()`). Stores uploaded document **storage paths** in `bookings.documents`, not public URLs (see the `esf-documents` privacy migration below). |
| `cancel-booking` | None (`--no-verify-jwt`), gated by Cloudflare Turnstile | Verifies the Turnstile token, calls `cancel_booking_secure()` RPC, then sends the cancellation-confirmation email itself (`sendCancellationEmail()`, calls `sendViaZoho()` in-process, same as `queue-bulk-email`). |
| `send-email` | Admin JWT **or** the raw `SUPABASE_SERVICE_ROLE_KEY` as Bearer token ("trusted service call") | The only function that actually talks to Zoho. Delegates to `_shared/zoho.ts`. |
| `queue-bulk-email` | Admin JWT only | Atomically inserts N `email_queue` rows as `Pending`, responds immediately, then drains them **in-process** (calls `sendViaZoho()` directly, not over HTTP) via `EdgeRuntime.waitUntil()` in the background. |
| `get-reviews` | Admin JWT or trusted service call | SerpApi Google Maps review lookup for a business name, used by the performer-review-check feature. |
| `get-booking-documents` | Admin JWT only | Resolves a booking's `documents` storage paths to time-limited (1hr) signed URLs via `createSignedUrls()` — `esf-documents` is a private bucket. Called from `js/shared.js`'s `populateDetailPane()` when rendering the Kanban/Summary detail pane. |
| `_shared/zoho.ts` | n/a (imported, not deployed) | Zoho OAuth2 token refresh/cache + send logic, shared by `send-email` and `queue-bulk-email`. |
| `_shared/bucket.ts` | n/a (imported, not deployed) | Resolves the document bucket name (env var, else `settings.bucket_name`, else `'esf-documents'`), shared by `submit-booking` and `get-booking-documents`. |

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

### No migrations framework
There is no Prisma/Knex/Supabase-migrations setup. Every schema change is a standalone
`.sql` file at the repo root (`fix_*.sql`, `add_*.sql`, `drop_*.sql`), each with a header
comment explaining what/why, the actual DDL, and a `-- VERIFY:` query at the bottom. The
established workflow: **draft the file → a human runs it in the Supabase SQL Editor →
they confirm it applied and that the affected feature still works → commit it as a
permanent record.** No agent should execute SQL directly against the live database.

---

## 4. Current State

### Fully built and working
- Public booking forms (Food, General/Non-Food) + admin-added Misc entries
- Kanban board and searchable/sortable list ("Summary") views, both with bulk-email
- Location Manager — multi-location assignment per booking, occupancy-conflict enforced
  at the DB level, Google My Maps CSV export, search/sort
- Payment tracking, statistics/charts, visitor map (Leaflet)
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

---

## 5. Data Model

### `bookings` — the central table
One row per application, all types share this table, distinguished by `instance_prefix`
(`ESF26-FOOD-`, `ESF26-NONFOOD-`, `ESF26-MISC-`, `ESF26-DEV-`). Key columns: `id` (text
PK, e.g. `ESF26-FOOD-0042`), `status` (`Pending`/`Confirmed`/`Rejected`/`Cancelled`/
`On Hold`/`HCC Checks`), `business_name`, `owner_name`, `email`, `stall_cost`,
`cancel_token`, `rejection_reason`. **`bookings.location_id` still exists as a column
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
One row per chargeable confirmed booking: `booking_id` (FK), `stall_cost`, `paid`
(boolean), `date_paid`, `bank_ref`, `editor`.

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
`payment_reminder`), `subject`, `body_html` — both support `{{placeholder}}`
substitution (`owner_name`, `business_name`, `booking_id`, `cancel_link`, `cost`,
`bank_details`, `location_id`/`location_display`, `reason`).

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
`map_center_lat/lng`, `hcc_council_email`, plus all `zoho_*` credentials/cached tokens.

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
# submit-booking and cancel-booking specifically need:
supabase functions deploy submit-booking --no-verify-jwt
supabase functions deploy cancel-booking --no-verify-jwt
```
Requires the CLI to be logged in and linked to the project (`supabase login`,
project ref `rsnxhuhibglieofikkpo`). The CLI version used this session (`v2.72.7`) does
**not** support `supabase functions logs` — use the Supabase Dashboard's
Functions → *name* → Logs tab instead.

### Creating an admin/steward user
1. Create a Supabase Auth user (dashboard, or let them sign up if signup is enabled —
   **check first**, it was found enabled-by-accident and disabled this session).
2. Add a row to `user_roles` with their auth `user.id` and `role = 'admin'` or
   `'steward'` — via `manage_users.html` or directly in SQL.

### Testing
No automated tests exist. Verification is manual: run locally, log in with real
admin/steward credentials against the live project, exercise the actual flow in a
browser, and (for anything DB-related) check the affected table's state directly in the
Supabase Table Editor or SQL Editor afterward.

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

### SQL fix files
Root-level, named `verb_target.sql` (`fix_bookings_rls_exposure.sql`,
`add_schedules_location_fk.sql`, `drop_unused_admin_functions.sql`). Structure: header
comment block (what/why), the DDL, a `-- VERIFY:` query. Never run automatically —
always handed to a human to paste into the SQL Editor, confirmed working, then committed.

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

- **No formal migrations tool.** Every `.sql` file at repo root is a one-shot script,
  run once manually by a human via the Supabase SQL Editor, never by an agent directly.
  There's no rollback mechanism — changes need to be reviewed carefully before running,
  and are expected to be additive/backward-compatible where possible.

- **File uploads**: 12MB limit, bucket `esf-documents`. `submit-booking` validates the
  temp-upload UUID and filenames server-side against strict patterns
  (`SAFE_TEMP_UUID_PATTERN`, `SAFE_FILENAME_PATTERN`) before moving them into the final
  storage path — never trust the client-sanitized values verbatim, they're trivially
  bypassable by calling the public endpoint directly.

- **The performer-application public form** (`ellafestperformersadmin.vercel.app/public/apply.html`)
  writes directly to this same project's `performers` table from a **separate**
  codebase/deployment. If you change `performers`' schema or RLS, that other app is a
  real, live consumer you won't see by grepping this repo.
