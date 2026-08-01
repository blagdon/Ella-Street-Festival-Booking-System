# Working in this repo

Read `HANDOVER.md` first — it's the full reference (architecture, data model,
conventions, gotchas, agent-autonomy risk tiers). This file is just the one
habit worth surfacing every session rather than leaving buried in a 3800-line
doc.

## Sweep for every instance of a pattern before calling a fix done

If a fix addresses one instance of something implemented independently in
more than one place — a modal, a form-validation pattern, a delegated
click-listener, a repeated CSS-class mistake — **grep for every other
instance across the whole codebase before considering that class of work
finished.** Don't stop at the files already in scope for the current task.

This isn't hypothetical caution: `js/summary.js`'s modals were missed when
focus-trapping/Escape-key handling was added to every modal in the app,
because `summary.js` duplicates `kanban.js`'s modal machinery under different
names — a page-by-page review didn't catch the duplication. It resurfaced as
a live bug report. The *second* miss (`index.html`'s password-reset modal,
reachable through a separate pre-auth code path) was only found afterward by
grepping every `id="*Modal*"` across every `.html` file — not by the review
itself, no matter how thorough it felt at the time.

## Multi-Tenant SaaS Platform Foundation (v7.17.0+)

The application is evolved into a multi-tenant ready platform:
- **Tenants & Events**: `organisations` (`org_default`) and `events` (`event_default`).
- **Membership**: `organisation_members` table (kept in sync with `user_roles` via `trg_sync_organisation_members` trigger).
- **Settings**: Composite primary key `(org_id, key)` for per-tenant configuration isolation.
- **Normalised Booking Type**: `bookings.booking_type` (`food`, `general`, `misc`, `dev`) while retaining `instance_prefix` for booking ID generation and legacy compatibility.
- **Security & RLS**: `check_user_role()` and SECURITY DEFINER RPCs query `organisation_members` with `user_roles` fallback; `get_current_org_id()` provides dynamic tenant resolution.

## Verification Commands

- `npm run test:integration` — Full node test runner suite (282 tests, includes `foundation.test.mjs` and `phase2-tenant-isolation.test.mjs`).
- `npm run test:a11y` — Playwright public accessibility suite.
- `npm run test:a11y:admin` — Playwright admin accessibility & focus-trap suite.
- `npm run lint` — ESLint validation.
- `npm run typecheck` — TypeScript check (`tsc -p jsconfig.json`).
- `npm run check:innerhtml-escaping` — innerHTML safety guard.

