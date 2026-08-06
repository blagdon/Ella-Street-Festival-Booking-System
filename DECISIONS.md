# Architecture Decisions — Ella Street Festival Booking System

This file records the *why* behind decisions that weren't obvious, had a real
alternative on the table, or have already been re-litigated once by someone who
didn't know the reasoning and nearly undid it. It's not a changelog (see
`CHANGELOG.md`) and it's not a full narrative history (see `HANDOVER.md`, which has
the incident-by-incident writeup most of these are drawn from) — it's the condensed
answer to "why is it built this way and not the more obvious way," kept short enough
that someone will actually read it before changing the thing.

Each entry: **Context** (the problem), **Decision** (what was actually done),
**Alternatives considered** (what wasn't done, and why not), **Consequences** (what
this costs or constrains going forward). Status is `Accepted` unless noted.

## Index

1. [`booking_prefix` stays a typed column on `events`, not an `event_settings` override](#1-booking_prefix-stays-a-typed-column-on-events-not-an-event_settings-override)
2. [Public booking context is resolved server-side, never trusted from the client](#2-public-booking-context-is-resolved-server-side-never-trusted-from-the-client)
3. [`event_settings` is a separate table from `settings`, not a scope column on it](#3-event_settings-is-a-separate-table-from-settings-not-a-scope-column-on-it)
4. [`has_org_role()` replaced the global-fallback role check for tenant-scoped tables](#4-has_org_role-replaced-the-global-fallback-role-check-for-tenant-scoped-tables)
5. [Public locations are read through an RPC, never a direct anon table grant](#5-public-locations-are-read-through-an-rpc-never-a-direct-anon-table-grant)
6. [`is_platform_admin()` is a distinct concept from "admin of some organisation"](#6-is_platform_admin-is-a-distinct-concept-from-admin-of-some-organisation)
7. [Tenant-scoping helpers are `SECURITY DEFINER`, not inline `EXISTS` subqueries](#7-tenant-scoping-helpers-are-security-definer-not-inline-exists-subqueries)
8. [The provisioning trigger only ever updates an existing `org_default` row, never creates one](#8-the-provisioning-trigger-only-ever-updates-an-existing-org_default-row-never-creates-one)
9. [`user_roles` stays as a legacy global table instead of being removed](#9-user_roles-stays-as-a-legacy-global-table-instead-of-being-removed)
10. [The Stripe webhook keeps using `org_default`'s credentials, deliberately, for now](#10-the-stripe-webhook-keeps-using-org_defaults-credentials-deliberately-for-now)
11. [Documents are served through a signed-URL function, never a direct storage read policy](#11-documents-are-served-through-a-signed-url-function-never-a-direct-storage-read-policy)
12. [Deploys are test-project-first, always, with no exception for "it's just additive"](#12-deploys-are-test-project-first-always-with-no-exception-for-its-just-additive)
13. [TypeScript checking is per-file opt-in, not a repo-wide `checkJs: true`](#13-typescript-checking-is-per-file-opt-in-not-a-repo-wide-checkjs-true)

---

## 1. `booking_prefix` stays a typed column on `events`, not an `event_settings` override

**Context.** Epic 4 Phase 4B added `event_settings` specifically to let an organiser
override certain org-level settings for just one event (display name, stall prices,
allowed stall types). `booking_prefix` looks like it belongs in that same list — it's
event-specific, an organiser would plausibly want to change it per event.

**Decision.** `booking_prefix` was deliberately excluded from `event_settings`. It
stays exactly where it already was: a typed column on `events`, edited in the event
editor (`js/page-admin.js`), resolved through `getActiveBookingPrefix()`
(`js/config.js`) via the cached active-event object in
`localStorage['ESF_ACTIVE_EVENT']` — checked *before* any settings-table value ever
enters the picture.

**Alternatives considered.** Routing it through `event_settings` like the other four
overridable fields, for consistency. Rejected once the existing event editor was
checked: `booking_prefix` already had a complete, working, exclusively-used
resolution path. Adding a second place to set the same value wouldn't have been
"more consistent," it would have been a second, silently-ineffective control — the
`event_settings` row would save, show an "Overridden" badge, and every real booking
ID generated from that event would keep using whatever's on the `events.booking_prefix`
column instead, because that's the only place `getActiveBookingPrefix()` ever looks.

**Consequences.** Before adding *any* new field to Event Configuration, the existing
resolution path for that field has to be checked first — is it already resolved
through some other event-scoped mechanism? If yes, routing it through
`event_settings` too creates exactly this trap. This has already happened once
(`booking_prefix`); it's the reason to check, not a one-off note.

---

## 2. Public booking context is resolved server-side, never trusted from the client

**Context.** Phase 4D added `?org=&event=` slugs to the public booking forms so a
link could resolve to a specific organisation's specific event. The obvious
implementation has the client resolve the slugs, then send `org_id`/`event_id`
straight through in the booking payload.

**Decision.** `submit-booking` resolves and persists the real organisation/event
itself, server-side, via `resolvePublicBookingContext(supabaseAdmin, orgSlug,
eventSlug)`. Client-supplied `org_id`/`event_id` on the request body are not read at
all — `sanitizeBookingInput()` never even looks at those keys.

**Alternatives considered.** Trusting client-resolved `org_id`/`event_id` and just
validating they're real ids. Rejected: an anonymous public endpoint that trusts
tenant-identifying fields from the request body is a direct cross-tenant write
primitive — a crafted request could submit a booking into any organisation just by
naming its id, with no relationship to the URL slug the visitor actually used. The
server already has to resolve the event to check its lifecycle status (`draft` /
`open` / etc.) before accepting a submission; resolving the org at the same time,
from the same slugs, and discarding anything the client sent costs nothing extra and
closes the hole entirely.

**Consequences.** Every public-facing Edge Function that accepts an org/event-scoped
write (`submit-booking`, and by the same reasoning `cancel-booking`,
`get-payment-link`) must resolve tenant identity itself from a slug, token, or
session — never from a plain client-supplied id field. This is now the standing
pattern for any new public endpoint, not a one-off for booking submission.

---

## 3. `event_settings` is a separate table from `settings`, not a scope column on it

**Context.** The platform already had a two-level settings inheritance chain
(Platform Defaults → Organisation Settings, both living in the one `settings` table,
disambiguated by `org_id`). Phase 4B needed a third level: per-event overrides.

**Decision.** A new table, `event_settings` — same key/value shape as `settings`,
same RLS pattern, but scoped by `event_id` instead of `org_id`. `js/config.js`'s
`loadStallCosts()` applies organisation rows then event rows through the *same*
`applySettingsToConfig()` call, run twice, with no key-specific branching: an event
row for a key simply overwrites whatever the organisation row set.

**Alternatives considered.** Adding an `event_id` column to the existing `settings`
table (nullable, meaning "org-level" when null) and filtering by both `org_id` and
`event_id` in one table. Rejected — this would have meant every existing query
against `settings` needed to learn about a new column and a new nullability
convention, for a scope level that only a handful of keys ever need overridden. A
second table keeps the two inheritance levels structurally independent: `settings`
never has to know `event_settings` exists, and the resolver composes them by calling
the same function twice rather than needing new branching logic to understand a
compound key.

**Consequences.** Adding a fourth inheritance level later (if it's ever needed) is
the same move again — a new table, the same key/value shape, one more call to
`applySettingsToConfig()`. The original migration for `event_settings` copied
`settings`' table-level grants verbatim (`SELECT, INSERT, UPDATE`), which turned out
to be wrong: `settings` never deletes a row, but Event Configuration's Reset control
does, and the missing `DELETE` grant blocked the very first Reset click in
production. Copying another table's grants only carries over what *that* table's
write patterns needed — check what the new table's own write patterns will need
before assuming the copy is complete.

---

## 4. `has_org_role()` replaced the global-fallback role check for tenant-scoped tables

**Context.** `check_user_role(required_role)` was the platform's original
authorization primitive: check `organisation_members` for the caller's *current*
resolved tenant first, then fall back to the legacy global `user_roles` table if
that fails. The fallback exists for real backwards-compatibility reasons (every
organisation owner gets a global `user_roles` row during provisioning, for RPCs that
still read it directly) — but it means "has an admin role row *anywhere*" and "is
admin *of this row's organisation*" collapse into the same boolean the moment a
policy uses `check_user_role('admin')` without also comparing the row's own
`org_id` to the caller's. A live Launch Readiness Review found this had happened on
thirteen separate tables across four rounds of fixes: `bookings`, `locations`,
`events`, `booking_locations`, `email_templates`, `sms_templates`, `payments`,
`audit_logs`, `hcc_checks`, `email_queue`, `sms_queue`, `organisation_members`, and
(via a join, since it has no `org_id` column) `event_settings`.

**Decision.** A new `has_org_role(p_org_id text, p_roles text[])` SECURITY DEFINER
function, checking `organisation_members` for a real membership row matching *both*
the specific `org_id` being asked about and one of the given roles — never the
global table. Every tenant-scoped table's admin policy now reads
`is_platform_admin() OR has_org_role(<table>.org_id, ARRAY['admin'])` (or `['admin',
'steward']` for read-only staff access), correlating the row's own organisation
directly instead of asking "is this caller an admin of *something*."

**Alternatives considered.** Removing `check_user_role()`'s global fallback
entirely. Rejected (so far) — several existing RPCs still read `user_roles`
directly for legitimate backwards-compatibility reasons documented in
`20260801003_create_organisation_members.sql`, and ripping out the fallback wholesale
was a larger, riskier change than the actual bug warranted. The fix was narrower and
more targeted: stop *policies that need per-row tenant correlation* from using a
check that can't express it, rather than redesigning the underlying primitive.

**Consequences.** `check_user_role()` still exists and its global fallback is still
real — it is *correct* to use for genuinely global authorization questions (does
this user have an admin role at all), and *wrong* to use anywhere a policy needs to
know "admin of *this specific row's* organisation." Any new tenant-scoped table's
admin policy should use `has_org_role()` from the start, not `check_user_role()` —
copying an existing policy that predates this fix (there's a decent chance one still
does, somewhere) will silently reintroduce the exact bug this decision closed.
`performers`/`schedules`/`user_roles` itself are the deliberate exceptions: genuinely
single-tenant/legacy, not tables that were merely missed.

---

## 5. Public locations are read through an RPC, never a direct anon table grant

**Context.** The public map needs to show one organisation's live pitch layout to
anonymous visitors. The original policy, `"Public view locations" FOR SELECT USING
(dataset = 'LIVE')`, had no organisation filter at all — any anonymous request could
enumerate *every* organisation's live location layout in a single query, because RLS
has no way to correlate an anonymous request to "the one organisation this visitor
is legitimately looking at" from inside the policy itself; only the request's own
supplied parameters could do that, and a `USING` clause can't trust a value it
doesn't itself constrain.

**Decision.** Anon's direct `SELECT` grant on `locations` is revoked entirely. Reads
go through `rpc_get_public_locations(p_org_id text, p_dataset text)`, a SECURITY
DEFINER function that takes the organisation explicitly as a parameter and returns
only that organisation's rows for that dataset.

**Alternatives considered.** Adding an `AND org_id = <something>` clause to the
existing policy. Rejected as unworkable in principle, not just in practice — RLS
`USING` clauses evaluate against the row and `auth.uid()`/session context, with
nothing to bind to "the organisation named in this particular anonymous HTTP
request." An RPC parameter is the only mechanism that actually receives that value.

**Consequences.** This is now the standing pattern for *any* future anon-readable,
tenant-scoped data: no direct table grant, a parameterized RPC instead — mirroring
the precedent `storage.objects` already set (see decision 11). A bare anon `SELECT`
grant on a table with an `org_id` column should be treated as a default-deny
violation on sight, not something that needs its own investigation each time.

---

## 6. `is_platform_admin()` is a distinct concept from "admin of some organisation"

**Context.** The platform-admin "View As" workflow needs one genuine bypass: a real
platform administrator (not just any organisation's own admin) can browse and act on
*every* organisation. Early on, this bypass was implicit and unlabelled — several
policies just granted a blanket `check_user_role('admin')` pass, which is true for
*any* org's admin, not just a platform admin, and doesn't distinguish the two at all.

**Decision.** `is_platform_admin()` checks *only* whether the caller has a real
`organisation_members` row for `org_id = 'org_default'` with `role = 'admin'` —
deliberately not `check_user_role()`, whose primary check is scoped to whatever
organisation is "current" in the caller's session and would also return true for an
ordinary single-org admin. Every tenant-scoped policy's bypass clause is explicitly
`is_platform_admin() OR has_org_role(...)`, so the two authorization paths — "I'm a
genuine platform admin" vs. "I'm this specific row's own organisation's admin" —
stay visibly distinct in every policy that uses them, rather than folding into one
implicit check.

**Alternatives considered.** Keeping the bypass implicit inside `check_user_role()`
itself. Rejected: this was the actual root cause of two separate incidents (the
`organisations` table's write policy letting any single-org admin rename or delete
*any* organisation; the org-default-granting trigger silently making every
organisation *owner* a platform admin). An explicit, separately-named function makes
the distinction something a reviewer can see in the policy text itself, rather than
something they have to already know to go verify inside `check_user_role()`'s body.

**Consequences.** The platform-admin "View As ALL ORGS" browse capability goes
through an explicit, labelled path (`rpc_list_switchable_organisations()`,
UI-flagged with a "🛡️ ALL ORGS" badge) rather than living as an implicit RLS side
effect anywhere else. Any new "platform admin can see/do everything" requirement
should reuse `is_platform_admin()` by name, not re-derive an equivalent check.

---

## 7. Tenant-scoping helpers are `SECURITY DEFINER`, not inline `EXISTS` subqueries

**Context.** The first draft of the `has_org_role()` fix (decision 4) used an inline
`EXISTS (SELECT 1 FROM organisation_members WHERE ...)` directly inside each RLS
policy, rather than a separate function. It broke immediately: `organisation_members`
has its own RLS policy gating who can read it at all, and an inline subquery inside
another table's policy still runs *as the calling role* — so a steward's own
subquery, checking their own membership row, was silently filtered to nothing by
`organisation_members`' own policy before the outer policy ever saw a result, even
though the steward's row genuinely existed. Caught by a pre-existing regression test
(`tests/privilege-hardening.test.mjs`'s steward-read test) failing against that first
draft, not by reading the policy SQL.

**Decision.** `has_org_role()`, `is_platform_admin()`, and `check_user_role()` are
all `SECURITY DEFINER` functions — they run with the privileges of the function's
owner, not the calling role, so their own internal query against
`organisation_members`/`user_roles` bypasses RLS entirely and always sees the real
data, regardless of what policy is calling them or what role invoked it.

**Alternatives considered.** Loosening `organisation_members`' own RLS so a caller
can always read their own row, removing the recursion. Rejected as the less general
fix — it would only have solved this one case (a table checking its own membership
table inline) and left the same trap for any *other* future policy that needs to
check `organisation_members` (or any table with its own restrictive RLS) as part of
authorizing a *different* table.

**Consequences.** Any new authorization helper that queries a table with its own
restrictive RLS must be `SECURITY DEFINER`, or it will silently under-authorize
exactly the users it's meant to check — and this failure mode is easy to miss by
reading the SQL, since the query looks correct; it only shows up as a live 403/empty
result for a real non-admin session. This is why the project's standing convention
is to prove authorization changes with a live authenticated-session test, not a
read of the policy text.

---

## 8. The provisioning trigger only ever updates an existing `org_default` row, never creates one

**Context.** `sync_organisation_members_from_user_roles()` originally kept
`organisation_members` in sync with writes to the legacy `user_roles` table —
including inserting a new `org_default` membership row whenever a `user_roles` admin
row was written, regardless of which organisation was actually being provisioned.
Since every organisation owner receives a global `user_roles` admin row during
provisioning (for RPC backwards-compatibility, see decision 9), this meant *every*
organisation's owner was silently granted `org_default` — i.e., platform-admin —
membership, purely as a side effect of being provisioned at all. Confirmed live:
multiple affected accounts in the test project, one in production.

**Decision.** The trigger now only ever `UPDATE`s an *existing* `org_default`
membership row (keeping a genuine platform admin's role in sync if it changes) —
it never `INSERT`s a new one. Granting `org_default` membership is now something
that only happens explicitly (`js/page-manage-users.js`'s Add User flow writes it
directly when that's actually the intent).

**Alternatives considered.** Scoping the trigger's insert to check whether the
organisation being provisioned *is* `org_default` before granting membership.
Rejected as fragile — it would have kept the implicit-grant mechanism alive for the
one case it was "supposed" to cover, leaving the same footgun for the next
provisioning-adjacent trigger or RPC that touches `user_roles`. Removing the
implicit grant entirely is the fix that can't regress the same way twice.

**Consequences.** Anything that used to rely on this trigger's implicit grant must
now grant `org_default` membership explicitly, on purpose. This was the actual root
cause underneath several of the findings in decision 4's list — not a separate bug,
but the mechanism that made "any organisation owner already qualifies as a platform
admin" true in the first place.

---

## 9. `user_roles` stays as a legacy global table instead of being removed

**Context.** `user_roles` predates the multi-tenant `organisation_members` model
entirely — it's a flat, org-less "this user has this one global role" table. It
would be reasonable to expect it to have been fully replaced by now, given how much
of this project's recent history is closing gaps caused by code that still falls
back to it.

**Decision.** `user_roles` is kept, deliberately, as documented legacy
backwards-compatibility infrastructure — several RPCs still read or write it
directly, and `rpc_add_organisation_member` upserts a matching `user_roles` row
alongside every `organisation_members` write specifically so `check_user_role()`'s
fallback keeps working for any code path that hasn't been migrated yet. Its own RLS
policy (`policy_allow_all_admin`, gating on a global admin check) is *correctly*
unscoped — the table itself has no organisation concept to scope by, so an
org-correlated check would be meaningless, not more correct.

**Alternatives considered.** Removing it now that `organisation_members` covers the
same ground. Rejected for this pass — every table-by-table fix in decision 4 closed
a *specific, provable* cross-tenant leak; removing `user_roles` outright is a much
larger, structurally different change (every remaining direct reader/writer would
need to be found and migrated first) that this work deliberately didn't expand into,
per the standing instruction to fix the smallest thing that closes the proven gap,
not redesign the architecture.

**Consequences.** `user_roles` remains real, load-bearing infrastructure, not dead
code — don't remove it without first finding and migrating every direct reader and
writer. It is *not* an instance of the org-scoping bug pattern (decision 4) and
doesn't need `has_org_role()`-style scoping; a global table's own admin-management
policy being global is correct, not a gap.

---

## 10. The Stripe webhook keeps using `org_default`'s credentials, deliberately, for now

**Context.** Every organisation's Stripe checkout, payment-link, and refund
activity was found to run against `org_default`'s Stripe credentials regardless of
which organisation the customer actually booked with — `loadStripeSettings()`'s
`orgId` parameter defaulted silently, and every call site omitted it. Fixed at three
of the four call sites (`create-checkout-session`, `get-payment-link`,
`refund-payment`) by threading `booking.org_id` through explicitly.

**Decision.** The fourth call site, `stripe-webhook`, is *not* fixed the same way —
it still loads `org_default`'s credentials, and this is documented in place as
deliberate rather than silently left broken. Stripe signature verification must
succeed *before* the webhook payload can be parsed at all, and the organisation a
given event belongs to is only knowable from inside that payload. A single shared
webhook endpoint cannot select per-organisation credentials without already knowing
which organisation it's verifying for — which is exactly the information signature
verification is what unlocks.

**Alternatives considered.** Parsing the payload before verifying the signature, to
learn the organisation first. Rejected outright — this would mean trusting
unverified webhook content to make a security decision (which credentials to
verify *against*), which defeats the purpose of signature verification entirely.

**Consequences.** This is a real, tracked limitation, not a false sense of having
"fixed Stripe": it only starts to matter once a second organisation has its own live
Stripe account receiving webhook events. The actual fix, when needed, is a distinct
webhook URL per organisation (so the *URL itself* identifies which organisation's
signing secret to verify against, before any payload parsing) — not a code change to
this shared endpoint.

---

## 11. Documents are served through a signed-URL function, never a direct storage read policy

**Context.** Uploaded booking documents (insurance certificates, etc.) need to be
downloadable by the admins who are supposed to see them, without becoming broadly
readable.

**Decision.** `storage.objects` has RLS enabled with exactly one policy: a narrowly
scoped public `INSERT` (file type + size limit, one bucket only). There is no
read/update/delete policy at all — every download goes through a server-side
signed-URL function (`get-booking-documents`). This deny-by-default shape was the
precedent decision 5's `rpc_get_public_locations()` fix deliberately followed once
the same "no anon table grant, only a controlled function" need arose for public
location data.

**Alternatives considered.** A scoped anon/authenticated `SELECT` policy on
`storage.objects`, correlated to the booking's organisation. Not seriously
considered as the primary path — a function that decides per-request whether to
issue a signed URL is strictly more controllable (can add rate-limiting, logging,
expiry, and arbitrary authorization logic in one place) than a declarative RLS
policy trying to express the same thing on a generic storage table.

**Consequences.** Any new class of protected file needing controlled read access
should follow this same shape by default — no direct storage read grant, a signed-URL
function instead — rather than each new document type getting its own bespoke RLS
policy on `storage.objects`.

---

## 12. Deploys are test-project-first, always, with no exception for "it's just additive"

**Context.** This project maintains two live Supabase projects: a disposable test
project and production. Multiple incidents in this project's history trace back to
skipping the test-project step or getting the CLI's linked project wrong — a
migration applied to the wrong project, an RLS check run against the wrong
project's data, at least one near-miss where test-project rollback-test accounts
were nearly reported as a production incident.

**Decision.** Every migration and Edge Function change goes to the disposable test
project first, is verified live (including with a throwaway account exercising both
the allow and deny paths, not just "the migration applied without error"), and only
then goes to production — followed immediately by re-verifying live on production
too, via direct schema introspection, never inferred from "the migration file looks
right" or "the PR merged." `supabase/.temp/project-ref` is checked before every `db
push`/`functions deploy`, and the CLI is always relinked back to the test project as
the last step of any production-touching work, not left pointed at production
between sessions.

**Alternatives considered.** Trusting "additive" changes (new tables, new columns
with safe defaults) to skip the test-project step, since they can't break existing
data. Rejected — the actual incidents that motivated this discipline were mostly
*additive* changes (a new RLS policy, a new trigger) that were nonetheless wrong in
ways only live testing caught (the RLS-recursion bug in decision 7; the org_default
trigger's over-broad grant in decision 8). "Additive" describes the schema change,
not the correctness of its logic.

**Consequences.** `rls_grants_snapshot.txt` is regenerated *only* from production,
never from the test project, since the two projects' RLS/grant state can and does
drift — the snapshot exists specifically to catch the moment production's real
policies stop matching what the migrations in this repo claim they should be, and
generating it from the test project would defeat that purpose silently.

---

## 13. TypeScript checking is per-file opt-in, not a repo-wide `checkJs: true`

**Context.** Most of `js/` is untyped JavaScript. Adding real type-checking value
without a slow, all-or-nothing migration meant deciding how strictly to turn it on.

**Decision.** `jsconfig.json` has `checkJs: false` at the project level; a file only
gets checked once it opts in with its own `// @ts-check` comment at the top. A file
is only opted in once its JSDoc `@param`/`@returns` tags are specific enough that
`tsc` won't just flag "property X does not exist on type object" everywhere — a
too-generic `{object}` type is treated as worse than no type at all, since it hides
real shape information behind a false sense of coverage.

**Alternatives considered.** `checkJs: true` repo-wide, accepting a large initial
wave of noisy findings on files nobody had prepared. Rejected — this codebase's
dependencies include files outside `js/` (e.g. `supabase-public.js`, imported by
several `js/*.js` modules) that aren't opted in and don't yet type-check cleanly;
`checkJs: true` would force-check every such dependency's full body at every import
site, breaking CI on files nobody had opted in to fixing yet, rather than letting
adoption proceed file by file.

**Consequences.** A new `.js` file starts unchecked until it adds its own
`// @ts-check` comment — this is intentional, not an oversight to "eventually fix."
As of 2026-07-31 every file under `js/` had in fact opted in and passed clean (full
current coverage), and `typecheck` is now a required CI check on that basis — but
the per-file mechanism stays even at full coverage, since it's also what lets a
newly added file start unchecked without breaking the invariant that every *checked*
file is checked on purpose.
