# Changelog

All notable changes to this project are documented in this file.

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
