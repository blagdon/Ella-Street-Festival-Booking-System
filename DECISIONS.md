# Architecture Decisions — Ella Street Festival Booking System

This file records the *why* behind decisions that weren't obvious, had a real
alternative on the table, or have already been re-litigated once by someone who
didn't know the reasoning and nearly undid it. It's not a changelog (see
`CHANGELOG.md`) and it's not a full narrative history (see `HANDOVER.md`, which has
the incident-by-incident writeup most of these are drawn from) — it's the condensed
answer to "why is it built this way and not the more obvious way," kept short enough
that someone will actually read it before changing the thing.

**Numbering is permanent and append-only.** A decision keeps its number forever,
even if it's later superseded — so it stays a stable thing to reference in a code
review or a commit message ("see decision 4"). New decisions always get the next
number in sequence; nothing already here is ever renumbered.

**Status** is one of:
- `Accepted` — current, in effect.
- `Superseded by decision N` — no longer the active decision; kept in place (not
  deleted) so the reasoning that led here stays readable, with a pointer to
  whatever replaced it.

Each entry: **Context** (the problem), **Decision** (what was actually done),
**Alternatives considered** (what wasn't done, and why not), **Consequences** (what
this costs or constrains going forward).

## Platform timeline

```
Pre-multi-tenant (through v6.x, earliest tagged history 2026-07-15)
  Single organisation, single event, no tenant concept at all.
        │
        ▼
Multi-Tenant Foundation (2026-08-01, 09:59, PR #130 "Phase 1 & 2")
  organisation_members, per-tenant settings — the data-model foundation
  everything below is built on. Not itself epic-numbered; "Epic 1" starts
  33 minutes later, on top of this.
        │
        ▼
Epic 1 — Platform Context Foundation (2026-08-01, 10:32 → same day)
  1A Platform Context Foundation · 1B Business Services Evolution ·
  1C UI & Navigation Context Exposure (v7.18.0)
        │
        ▼
Epic 2 — Platform Administration (2026-08-01, same day, → 14:31)
  2A Platform Administration Workspace & UI Library ·
  2B Settings Hub, Branding & Member Management ·
  2C Event Service, Navigation Event Selector & Platform Dashboard (v7.19.0)
        │
        ▼
Epic 3 — Provisioning (2026-08-02 → 2026-08-03)
  Platform provisioning engine, setup wizard, platform defaults, event
  lifecycle. Closed as v7.21.0 "Epic 3 Complete" (2026-08-03).
        │
        ▼
Epic 4 — Public Context, Event Settings, Tenant Isolation (2026-08-04 → 2026-08-06)
  Public identity/event resolution, location management, event-level config
  overrides, URL-based public booking routing — plus three rounds of live
  operational certification that found and closed every remaining cross-tenant
  gap the new multi-tenant surface had opened up.
        │
        ▼
v7.22.0 "Epic 4 Complete" (2026-08-06) — Launch Ready
```

Epic 1 and Epic 2 land the *same day* as the multi-tenant foundation, several
hours *after* it, not as separate prior work — the "Epic 3" naming refers
specifically to the provisioning engine, not to multi-tenancy itself, which is
why it isn't decision 4/6/7/8/9's "Established" epic even though those
decisions are all about tenant isolation.

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
14. [`email_templates`/`sms_templates` use a composite `(org_id, id)` primary key](#14-email_templatessms_templates-use-a-composite-org_id-id-primary-key)
15. [`locations` keeps its composite `(id, dataset)` primary key with no `org_id`](#15-locations-keeps-its-composite-id-dataset-primary-key-with-no-org_id)
16. [Phase 2B–2E: tenant/event integrity closed with database constraints wherever safely possible from this repo alone](#16-phase-2b2e-tenantevent-integrity-closed-with-database-constraints-wherever-safely-possible-from-this-repo-alone)

---

## 1. `booking_prefix` stays a typed column on `events`, not an `event_settings` override

> **Status:** Accepted · **Established:** Epic 4 Phase 4B · **Related:** [Decision 3](#3-event_settings-is-a-separate-table-from-settings-not-a-scope-column-on-it)

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

> **Status:** Accepted · **Established:** Epic 4 Phase 4D · **Related:** [Decision 10](#10-the-stripe-webhook-keeps-using-org_defaults-credentials-deliberately-for-now)

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
pattern for any new public endpoint, not a one-off for booking submission. It's the
same "don't trust identity claims you haven't verified yourself" instinct behind
decision 10, applied on the other side of the trust boundary: there, the constraint
is that the org *can't* be known before verification; here, the constraint is that a
client-asserted org must never be trusted even though it easily *could* be read.

---

## 3. `event_settings` is a separate table from `settings`, not a scope column on it

> **Status:** Accepted · **Established:** Epic 4 Phase 4B · **Related:** [Decision 1](#1-booking_prefix-stays-a-typed-column-on-events-not-an-event_settings-override)

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

> **Status:** Accepted · **Established:** Launch Readiness Review, PR #174 (v7.22.0) · **Related:** [Decision 6](#6-is_platform_admin-is-a-distinct-concept-from-admin-of-some-organisation), [Decision 7](#7-tenant-scoping-helpers-are-security-definer-not-inline-exists-subqueries), [Decision 8](#8-the-provisioning-trigger-only-ever-updates-an-existing-org_default-row-never-creates-one)

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
single-tenant/legacy, not tables that were merely missed (see decision 9).

---

## 5. Public locations are read through an RPC, never a direct anon table grant

> **Status:** Accepted · **Established:** Launch Readiness Review, PR #174 (v7.22.0) · **Related:** [Decision 11](#11-documents-are-served-through-a-signed-url-function-never-a-direct-storage-read-policy)

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
the precedent `storage.objects` already set (decision 11, established earlier). A
bare anon `SELECT` grant on a table with an `org_id` column should be treated as a
default-deny violation on sight, not something that needs its own investigation each
time.

---

## 6. `is_platform_admin()` is a distinct concept from "admin of some organisation"

> **Status:** Accepted · **Established:** RC Operational Certification, PR #167 — refined in PR #174 (see decision 8) · **Related:** [Decision 4](#4-has_org_role-replaced-the-global-fallback-role-check-for-tenant-scoped-tables), [Decision 8](#8-the-provisioning-trigger-only-ever-updates-an-existing-org_default-row-never-creates-one)

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
organisation *owner* a platform admin — decision 8). An explicit, separately-named
function makes the distinction something a reviewer can see in the policy text
itself, rather than something they have to already know to go verify inside
`check_user_role()`'s body.

**Consequences.** The platform-admin "View As ALL ORGS" browse capability goes
through an explicit, labelled path (`rpc_list_switchable_organisations()`,
UI-flagged with a "🛡️ ALL ORGS" badge) rather than living as an implicit RLS side
effect anywhere else. Any new "platform admin can see/do everything" requirement
should reuse `is_platform_admin()` by name, not re-derive an equivalent check.
Its own body was later corrected, not superseded, by decision 8's fix — it always
checked "real `org_default` membership," but the *data* behind that membership was
wrong until the provisioning trigger stopped over-granting it. The decision to have
a distinct function was right from the start; what it read got fixed underneath it.

---

## 7. Tenant-scoping helpers are `SECURITY DEFINER`, not inline `EXISTS` subqueries

> **Status:** Accepted · **Established:** Launch Readiness Review, PR #174 (v7.22.0) · **Related:** [Decision 4](#4-has_org_role-replaced-the-global-fallback-role-check-for-tenant-scoped-tables), [Decision 12](#12-deploys-are-test-project-first-always-with-no-exception-for-its-just-additive)

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
(decision 12) is to prove authorization changes with a live authenticated-session
test, not a read of the policy text.

---

## 8. The provisioning trigger only ever updates an existing `org_default` row, never creates one

> **Status:** Accepted · **Established:** Launch Readiness Review, PR #174 (v7.22.0) · **Related:** [Decision 4](#4-has_org_role-replaced-the-global-fallback-role-check-for-tenant-scoped-tables), [Decision 6](#6-is_platform_admin-is-a-distinct-concept-from-admin-of-some-organisation)

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
admin" true in the first place, and the reason decision 6's `is_platform_admin()`
was reading bad data even though its own logic was always correct.

---

## 9. `user_roles` stays as a legacy global table instead of being removed

> **Status:** Accepted · **Established:** Multi-Tenant Foundation, PR #130 (`20260801003_create_organisation_members.sql`) · **Related:** [Decision 4](#4-has_org_role-replaced-the-global-fallback-role-check-for-tenant-scoped-tables), [Decision 8](#8-the-provisioning-trigger-only-ever-updates-an-existing-org_default-row-never-creates-one)

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

> **Status:** Accepted · **Established:** Launch Readiness Review, PR #174 (v7.22.0) · **Related:** [Decision 2](#2-public-booking-context-is-resolved-server-side-never-trusted-from-the-client)

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

> **Status:** Accepted · **Established:** predates Epic 3 (exact version not tracked) · **Related:** [Decision 5](#5-public-locations-are-read-through-an-rpc-never-a-direct-anon-table-grant)

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

> **Status:** Accepted · **Established:** standing convention, `HANDOVER.md` §7 · **Related:** [Decision 7](#7-tenant-scoping-helpers-are-security-definer-not-inline-exists-subqueries), [Decision 8](#8-the-provisioning-trigger-only-ever-updates-an-existing-org_default-row-never-creates-one)

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

> **Status:** Accepted · **Established:** predates Epic 3 (exact version not tracked); full `js/` coverage reached 2026-07-31

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
As of 2026-07-31, 73 of `js/`'s 74 first-party files had opted in and passed clean;
the one exception, `js/vendor/supabase.js`, is a vendored third-party bundle, which
is standard practice to leave unchecked rather than fighting its own type shape.
`typecheck` is a required CI check on that basis — but the per-file mechanism stays
even at this near-total coverage, since it's also what lets a newly added file start
unchecked without breaking the invariant that every *checked* file is checked on
purpose.

---

## 14. `email_templates`/`sms_templates` use a composite `(org_id, id)` primary key

> **Status:** Accepted · **Established:** Epic 3, `20260802200_composite_pk_templates.sql` (2026-08-02) · **Related:** [Decision 4](#4-has_org_role-replaced-the-global-fallback-role-check-for-tenant-scoped-tables)

**Context.** Template ids (`application_received`, `booking_confirmed`, etc.) were
originally globally unique — one `application_received` row, full stop. Once each
organisation needed to be able to customise its own copy of the same named
template, `id` alone could no longer identify a row.

**Decision.** Both tables' primary key was changed from `(id)` to `(org_id, id)`,
following the identical precedent `settings` had already set the day before
(`20260801005_settings_composite_pk.sql`, evolving `(key)` to `(org_id, key)` for
the same reason — per-organisation Stripe keys, stall costs, etc., without name
collision). `rpc_initialise_tenant_defaults()`'s template-cloning `INSERT`s were
updated to `ON CONFLICT (org_id, id)` to match.

**Alternatives considered.** A surrogate UUID primary key with `id` demoted to an
ordinary (now non-unique) column, `org_id` carried as a plain filter column instead
of part of the key. Not the path taken — `settings` had already established the
composite-natural-key shape as the working pattern for exactly this "same logical
key, once per organisation" problem the day before, and templates are structurally
identical to it (a small, named, per-organisation-overridable set of rows). Reusing
the proven shape kept the fix mechanical rather than open-ended.

**Consequences.** Every query against these two tables must include `org_id`, or it
either throws (`.single()` against multiple matching ids across organisations) or —
worse — silently resolves a different organisation's template content. This has
already caused one real regression: an early draft of a provisioning-fix migration
was built from the *pre*-composite-key version of `rpc_initialise_tenant_defaults()`
and would have reintroduced bare `ON CONFLICT (id)`, breaking every future
provisioning run with a `42P10` error — caught by exercising provisioning end-to-end
against the test project, not by reading the migration. Any new code that reads or
writes `email_templates`/`sms_templates` by `id` alone, without `org_id`, is either a
platform-default/legacy-single-tenant path (verify that's actually true) or a bug.

---

## 15. `locations` keeps its composite `(id, dataset)` primary key with no `org_id`

> **Status:** Accepted · **Established:** Epic 4 Phase 4C · **Related:** [Decision 4](#4-has_org_role-replaced-the-global-fallback-role-check-for-tenant-scoped-tables), [Decision 14](#14-email_templatessms_templates-use-a-composite-org_id-id-primary-key)

**Context.** Phase 4C built a full admin module for managing physical pitch
locations (Add/Edit/Delete/Duplicate/Import-CSV/Export-CSV/Clone/bulk-delete).
`locations`' primary key predates the multi-tenant model entirely — `(id, dataset)`,
no `org_id` in the key at all. Two organisations independently choosing the same
generic pitch code (`P1`, confirmed live by cloning `org_default`'s own seed data
into a second organisation) collide directly at the database level rather than
being scoped apart the way `email_templates`/`sms_templates` now are (decision 14).

**Decision.** The primary key was *not* changed to include `org_id`. Instead,
collision handling was pushed to the application layer, split by how the id is
chosen: Add/Edit (an admin hand-picks the code) surface a collision as a plain
"that code's taken" message — the same treatment already used for org/event slug
collisions — while Duplicate/Import-CSV/Clone (which bulk-populate ids the admin
never hand-chose one at a time) proactively check dataset-wide via a shared
`resolveAvailableId()` helper and auto-suffix (`-2`, `-3`, ...) instead of erroring.

**Alternatives considered.** Migrating the primary key to `(org_id, id, dataset)`,
matching decision 14's shape exactly. Not taken for this pass — `locations` has
more existing dependents than the two template tables did (booking assignment,
CSV import/export, the public map RPC), making a key migration a larger, riskier
change than the admin module Phase 4C actually needed to ship. The chosen fix
closes the *practical* problem (two organisations' admins stepping on each other's
pitch codes) without altering the schema every existing query already relies on.

**Consequences.** This is a deliberate, working-as-intended limitation, not an
oversight — but it means `locations` is genuinely different from every other
tenant-scoped table in this document: its uniqueness constraint is *not*
organisation-aware, and every current and future write path that generates or
accepts a location `id` must know to check availability *within the dataset*
(not the organisation) and handle the collision itself, rather than trusting the
database to reject a cross-organisation clash the way it would on
`email_templates`/`sms_templates`. If `locations` ever gains enough further
dependents to make a key migration worthwhile on its own terms, decision 14's
`(org_id, id)` shape is the precedent to follow, not a new design.

**Revisited (2026-08-22, Phase 2E discovery).** Re-examined as part of the Phase
2B–2E tenant-integrity hardening sequence (Decision 16) to determine whether this
should finally be fixed. The conclusion held, for a stronger and more specific
reason than originally on record: `schedules_location_fkey`, a live foreign key
into this exact `(id, dataset)` key, is owned by a separate application
(`ellafestperformersadmin.vercel.app`) this repo cannot modify or fully audit, and
`schedules` has no `org_id` column of its own to migrate alongside a key change.
Changing `locations`' primary key would require coordinating a schema change in a
codebase outside this repo's control — not just a bigger migration, a cross-system
one. Production data was also checked directly: only `org_default` has ever
populated `locations` (140 rows; the other three organisations have none), so zero
real collisions have ever occurred — this remains a genuine but currently
theoretical gap, not a live defect. Do not act on this without either (a)
coordinating directly with whoever maintains the external application, or (b) new
evidence of an actual production collision.

---

## 16. Phase 2B–2E: tenant/event integrity closed with database constraints wherever safely possible from this repo alone

> **Status:** Accepted · **Established:** 2026-08-21 to 2026-08-22 · **Related:** [Decision 4](#4-has_org_role-replaced-the-global-fallback-role-check-for-tenant-scoped-tables), [Decision 14](#14-email_templatessms_templates-use-a-composite-org_id-id-primary-key), [Decision 15](#15-locations-keeps-its-composite-id-dataset-primary-key-with-no-org_id)

**Context.** A read-only investigation found that most tenant/event relationships
in the schema were enforced only by application discipline — RLS, RPC-internal
checks, and convention — never by the database itself. This was the same defect
class as an earlier real incident (`booking_type DEFAULT 'dev'` silently
mislabelling Misc bookings): a gap that costs nothing until the day a write path
gets it wrong, at which point it fails silently rather than loudly. This decision
covers the four-part sequence that closed it (see `HANDOVER.md`'s "Tenant/event
referential-integrity hardening (Phase 2B–2E)" entry in [Current State](
HANDOVER.md#4-current-state) for the full narrative; this entry records the *why*
behind each part's specific shape).

**Decisions.**

- **Phase 2B — remove the 13 transitional `org_id`/`event_id` column defaults.**
  Every live write path already supplied these explicitly; the defaults were inert
  Phase-1-to-Phase-2 migration scaffolding. Dropping the default (not adding a
  `NOT NULL` — most were already `NOT NULL`) turns a silent fallback into a loud
  failure for any future write path that forgets to supply one.
- **Phase 2C — enforce composite org/event ownership at the database level.**
  `bookings`/`locations` each had a single-column `event_id → events.id` FK, which
  checked the event existed but never that it belonged to the same organisation as
  the row referencing it. Replaced with composite FKs, `(org_id, event_id) →
  events(org_id, id)`, backed by a new `events_org_id_id_unique` constraint (a
  redundant-but-legal superset of `events.id`'s own uniqueness — zero risk to add).
  `ON DELETE RESTRICT` preserved unchanged from the FKs being replaced.
- **Phase 2D — add organisation FKs where the relationship was already clear and
  the data already clean.** `payments`, `sms_queue`, `email_queue`, `settings`,
  `email_templates`, `sms_templates` each had an `org_id` column with no FK to
  `organisations` at all. `ON DELETE RESTRICT` for the three operational-record
  tables (payments, queues — losing them to a cascading org deletion would be real
  data loss); `ON DELETE CASCADE` for the three organisation-owned-configuration
  tables (settings, templates — reasonable to remove alongside the organisation
  itself). Separately, `audit_logs.org_id` got the same `RESTRICT` treatment once
  two genuine historical production rows (real admin activity referencing
  since-deleted organisations) were deliberately deleted under an explicit
  decision that the audit history worth retaining is archived elsewhere — not a
  default assumption, a specific approved exception. `audit_logs.event_id` was
  deliberately left unconstrained: the data shows it isn't populated as a reliable
  relationship in practice (production: >90% of rows read `event_default`
  regardless of the row's real organisation), so a FK there would encode a
  relationship the data doesn't reflect. Whether/how `event_id` should ever become
  a hard fact is a separate, not-yet-made product decision.
- **Phase 2E — give `booking_locations` a real FK to `locations`, without
  changing `locations`' own primary key.** `booking_locations.location_id` had no
  FK at all; only a trigger and an RPC's own pre-check protected it, and only for
  those two write paths. Gave `booking_locations` its own `dataset` column
  (`NOT NULL DEFAULT 'LIVE'`, `CHECK (dataset = 'LIVE')` — DEV is retired) so a
  composite FK could reference `locations`' existing `(id, dataset)` key — the
  same precedent `schedules.dataset` already established for the same reason.
  `ON DELETE CASCADE`, deliberately not `RESTRICT`: the admin UI's own delete
  confirmation already promised "any booking currently assigned to it will be
  unassigned," which was false before this FK existed (the row was silently
  orphaned) — CASCADE makes that existing promise true rather than introducing a
  new failure mode the UI doesn't handle. The FK proves the location *exists*;
  org/event *ownership* matching remains exclusively the trigger's and RPC's job,
  unchanged — a plain FK cannot express "belongs to the same org/event as some
  other table's row" the way a trigger's join-based check can.
- **Do not force the externally-owned performer/schedules application's schema
  into this repo's migrations.** `locations`' primary key was deliberately not
  changed to include `org_id` (reaffirming Decision 15 — see its 2026-08-22
  addendum) precisely because doing so would require also changing `schedules`,
  which is owned by a separate application this repo cannot modify or safely
  audit. The same boundary applies to `performers`/`schedules` more generally:
  neither gained tenant-scope columns in this sequence, and none should be added
  here unilaterally.

**Consequences.** Every `org_id`/`event_id` column in the schema now has a real FK
except `audit_logs.event_id` (a deliberate, documented exception) and `locations`'
own primary key (a deliberate, documented, externally-gated exception). A
dedicated read-only audit performed immediately after Phase 2E found no further
gap that can be safely closed from this repo alone. **There is no "Phase 2F."**
The next tenant-hardening-adjacent work, if any is ever justified, should come
from new evidence (an actual production collision, a way to safely coordinate
with the external application, or a product decision about `audit_logs.event_id`)
— not from a numbering scheme. Each part shipped as its own migration with
dedicated regression tests, applied to TEST first and to production only after
independent verification; see the individual PR history (#226–#229) for the
full validation trail.
