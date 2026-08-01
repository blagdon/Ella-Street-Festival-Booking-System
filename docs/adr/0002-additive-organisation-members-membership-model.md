# ADR-0002: Additive `organisation_members` Membership Model

* **Status**: Accepted
* **Date**: 2026-08-01
* **Deciders**: Architecture & Security Team

---

## Context and Problem Statement

Initially, user authentication and authorization relied solely on a flat `user_roles` table (`id`, `role`, `email`). Seven SECURITY DEFINER RPCs and multiple RLS policies directly queried `user_roles` to evaluate admin/steward permissions.

Transitioning to a multi-tenant model requires mapping users to organisations (`org_id`) with tenant-scoped roles. Replacing `user_roles` immediately in a single phase would risk breaking production authorization across core workflows (payments, location assignments, booking cancellations) without an incremental safety net.

## Decision Drivers

* **Security & Safety**: Zero authorization regressions in live admin and steward workflows.
* **Gradual Migration**: Ability to migrate SECURITY DEFINER RPCs and RLS policies one by one, verified by automated test suites at each step.
* **Single Source of Truth during Transition**: Avoid silent drift between legacy roles and tenant membership.

## Decision Outcome

Chosen an **Additive Migration with Automated Trigger Sync**:
1. Created `organisation_members` table (`id`, `org_id`, `user_id`, `role`) with foreign key to `organisations`.
2. Initialised `organisation_members` with a backfill from `user_roles` mapped to `org_default`.
3. Implemented a database trigger (`trg_sync_organisation_members`) on `user_roles` so any role creation/update/deletion in `user_roles` automatically updates `organisation_members`.
4. Updated `check_user_role(required_role)` to primary-check `organisation_members` for the current tenant, with fallback to `user_roles`.

## Consequences

* **Positive**: Allows risk-free, multi-stage migration of security RPCs without breaking active session authorization.
* **Negative**: Temporary redundant table sync overhead via database trigger until legacy `user_roles` is fully deprecated in Phase 4.
