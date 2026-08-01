# ADR-0003: Staged Tenant RLS Isolation and Dynamic Claim Resolution

* **Status**: Accepted
* **Date**: 2026-08-01
* **Deciders**: Security & Data Architecture Team

---

## Context and Problem Statement

Enforcing tenant isolation at the database level requires Row Level Security (RLS) policies that scope queries by `org_id`. Hardcoding `org_id` values or relying solely on static fallbacks would prevent real multi-tenant JWT claims or per-user tenant membership resolution.

We needed an RLS evaluation model that dynamically resolves the user's active tenant (`org_id`) in a secure, efficient, and backwards-compatible manner.

## Decision Drivers

* **Security Boundaries**: Ensure RLS policies cannot be bypassed by unauthenticated or cross-tenant callers.
* **JWT Claim Support**: Support modern Supabase Auth JWT custom claims (`request.jwt.claims -> 'org_id'`).
* **Backwards Compatibility**: Default existing sessions seamlessly to `org_default`.

## Decision Outcome

Chosen a **Three-Tier Resolution Function (`get_current_org_id()`)**:
1. **Tier 1 (JWT Custom Claim)**: Reads `request.jwt.claims` for `org_id`. If present, returns `org_id`.
2. **Tier 2 (Membership Table Lookup)**: If `auth.uid()` is present, checks `public.organisation_members` for the user's assigned organisation.
3. **Tier 3 (Default Fallback)**: Returns `'org_default'`.

Updated RLS policies on `organisations` and `events` to restrict SELECT access to `id = get_current_org_id() OR check_user_role('admin')`.

## Consequences

* **Positive**: Fully supports both current single-tenant deployments and future multi-tenant JWT context without code changes.
* **Negative**: RLS policy performance depends on indexes; added composite and single-column indexes on `org_id` and `event_id` across domain tables.
