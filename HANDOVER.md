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
│   ├── migrations/              ← Supabase CLI migrations (public schema only, since 2026-07-14)
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
| `submit-booking` | None (`--no-verify-jwt`) | Only path for creating a public booking. Rebuilds the row from an explicit allow-list (`sanitizeBookingInput()`) rather than trusting the request body — mass-assignment protection. Sends the "received" auto-email itself (`sendReceivedEmail()`, calls `sendViaZoho()` in-process, same as `queue-bulk-email`/`cancel-booking`). Stores uploaded document **storage paths** in `bookings.documents`, not public URLs (see the `esf-documents` privacy migration below). |
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

**Known gap**: the baseline only covers `public`. The `storage.objects` RLS policies for
`esf-documents`/`documents`/`performer-documents` (written this session as root-level
fix files) aren't yet captured as a migration — would need to be extracted separately,
filtered to exclude Supabase's own internal storage schema setup. Not done yet.

**The ~30 existing root-level `fix_*.sql`/`add_*.sql`/`drop_*.sql` files are left in
place as historical record**, not retroactively converted into migrations — the baseline
already captures their combined end-state, and their header comments have real "why"
context worth keeping. They predate this workflow; don't add new ones going forward for
schema changes covered by the `public` schema — use a migration instead. Storage
bucket/policy changes (until the known gap above is closed) still follow the old
convention: a root-level fix file, run manually in the SQL Editor.

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
- **No real automated test suite** — `package.json` has only `tailwindcss`/`postcss`
  build scripts, no `.github/` CI. Nothing exercises the Edge Functions, RLS
  policies, or booking-ID/location-conflict logic — exactly the kind of stateful
  business logic that regresses silently (this session found three real bugs in
  that category: `queue-bulk-email`, `cancel-booking`, and `submit-booking` all
  independently hit the same sibling-function-HTTP-call failure, one of them live
  in production on a real submission). The 3-step plan discussed, cheapest first:
  1. **Done (2026-07-14)**: a git pre-commit hook (`.githooks/pre-commit`, wired up
     via `core.hooksPath`, auto-configured by `npm install`'s `postinstall`) blocks
     any commit containing `functions.invoke(` inside `supabase/functions/` — the
     exact pattern behind all three bugs above. Tested live: confirmed it blocks a
     deliberately-reintroduced bad call, and passes cleanly against the current
     codebase.
  2. **Done (2026-07-14)**: `npm run check:rls-grants`
     (`scripts/check-rls-grants-snapshot.sh`) dumps every `CREATE POLICY` and
     `GRANT`/`REVOKE` statement across `public`/`storage` from the live project
     and diffs it against the checked-in `rls_grants_snapshot.txt`. Run manually
     (hits the live project over the network, not wired into pre-commit). A
     clean run exits 0; a diff means RLS/grants changed since the snapshot was
     last committed — review it, then `npm run check:rls-grants -- --update`
     and commit the refreshed snapshot if the change is expected. Tested live:
     confirmed it creates the baseline, and reports a clean match on a
     no-change re-run.
  3. **Not started.** Real integration tests for Edge Functions and the booking-ID/
     location-conflict trigger logic (Deno's test runner against a live/DEV
     Supabase instance, or `pgTAP` for the trigger) — the biggest lift, no
     existing harness to build on.
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
No unit test suite exists for the frontend. Verification of anything not covered by
the integration suite below is manual: run locally, log in with real admin/steward
credentials against the live project, exercise the actual flow in a browser, and
check the affected table's state directly in the Supabase Table Editor or SQL Editor
afterward.

**All three steps of the grep-guard → RLS-snapshot-test → real-integration-tests plan
are done** as of 2026-07-14:
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
- `npm run test:integration` (`tests/integration.test.mjs`, Node's built-in
  `node:test`) runs real integration tests against the deployed
  `submit-booking`, `cancel-booking`, and `queue-bulk-email` Edge Functions plus
  the `get_next_booking_id`/`booking_locations_check_conflict`/
  `claim_pending_emails` database logic — this is where the retry-on-conflict
  fix for the booking-ID race (see [Next Steps](#8-next-steps) item 18) came
  from, caught by an actual concurrent-submission test, not code review.

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
Root-level `.sql` files named `verb_target.sql` (`fix_bookings_rls_exposure.sql`,
`add_schedules_location_fk.sql`, `drop_unused_admin_functions.sql`) are the pre-2026-07-14
convention: header comment block (what/why), the DDL, a `-- VERIFY:` query, handed to a
human to paste into the SQL Editor, confirmed working, then committed. These still exist
as historical record and the storage bucket/policy fixes still follow this pattern (see
[Migrations](#migrations-supabase-cli) for why). **For anything touching the `public`
schema**, the current convention is `supabase migration new <name>` under
`supabase/migrations/`, applied via a human running `supabase db push` — same
draft/review/confirm/commit shape, different mechanism.

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
    this suite and what setup it needs. Slack/Discord/Sentry-style alerting for Edge
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

- **`public` schema now has a real baseline migration (2026-07-14) — but `storage`
  schema migrations are a trap, don't include it in a dump meant to be replayed.**
  `supabase/migrations/20260714132316_baseline_schema.sql` was scoped to `public` only
  after an earlier attempt that included `storage` failed with `permission denied for
  schema storage` on `CREATE TYPE "storage"."buckettype"` — a Supabase-internal system
  type that every project already has, not something this project created. If you ever
  regenerate or extend the baseline, scope dumps to `public` explicitly
  (`supabase db dump --schema public`) and handle bucket/`storage.objects` policies
  separately, filtered to exclude Supabase's own internal storage schema setup. Old
  root-level `.sql` fix files still exist as historical record and remain the
  convention for storage bucket/policy changes until that gap is closed — no rollback
  mechanism either way, changes need review before running.

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
