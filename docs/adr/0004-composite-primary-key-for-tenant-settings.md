# ADR-0004: Composite Primary Key `(org_id, key)` for Tenant Settings

* **Status**: Accepted
* **Date**: 2026-08-01
* **Deciders**: Architecture & Database Engineering Team

---

## Context and Problem Statement

The legacy `settings` table used `key` as a single-column Primary Key (`PRIMARY KEY (key)`). In a multi-tenant platform, distinct organisations must configure their own settings independently (e.g. Stripe API keys, bank transfer references, booking fee rules, booking prefixes).

A single-column PK prevented two organisations from having their own setting value under the same key name (e.g. `booking_prefix`).

## Decision Drivers

* **Per-Tenant Configuration**: Every organisation must maintain independent settings without key collisions.
* **Query Backward Compatibility**: Code calling `SELECT key, value FROM settings` (such as `js/config.js → loadStallCosts()`) must continue returning all settings for the active tenant.
* **Migration Safety**: Existing single-tenant configuration keys must remain fully functional.

## Decision Outcome

Chosen **Composite Primary Key `(org_id, key)`**:
1. Added `org_id text NOT NULL DEFAULT 'org_default'` column to `settings`.
2. Dropped single-column constraint `settings_pkey` on `(key)`.
3. Created composite primary key `PRIMARY KEY (org_id, key)`.
4. Existing settings rows were backfilled with `org_id = 'org_default'`.

## Consequences

* **Positive**: Allows multi-tenant setting isolation natively at the database level. Enables tenant-scoped configuration upserts (`ON CONFLICT (org_id, key)`).
* **Negative**: Code writing to `settings` must include `org_id` in upsert conflict targets.
