# ADR-0001: Retain `instance_prefix` for Backwards Compatibility

* **Status**: Accepted
* **Date**: 2026-08-01
* **Deciders**: Architecture & Engineering Team

---

## Context and Problem Statement

The legacy system separated datasets and booking types using a string prefix column on `bookings`, `instance_prefix` (e.g. `ESF26-FOOD-`, `ESF26-NONFOOD-`, `ESF26-MISC-`, `ESF26-DEV-`). Booking IDs were formatted as `{PREFIX}-{NNNN}` (e.g., `ESF26-FOOD-0042`).

As the application moves toward a multi-tenant SaaS architecture, reliance on composite strings for dataset and category separation creates entanglement. We needed to introduce a clean relational `booking_type` enum (`food`, `general`, `misc`, `dev`) and `event_id` without breaking existing booking ID formats, public booking forms, or third-party integrations.

## Decision Drivers

* **Zero Breakage**: Public booking submission forms (`submit-booking` Edge Function), cancel tokens, and email links must continue operating without alteration.
* **Deterministic ID Generation**: The server-side sequential ID generation RPC (`get_next_booking_id`) and ID validation rules (`utils.js → validateBookingId()`) depend on `instance_prefix`.
* **Clean Querying**: Internal analytics, RLS policies, and database triggers need explicit relational columns rather than string pattern matching (`LIKE '%-FOOD-%'`).

## Considered Options

1. **Option A (Immediate Breaking Refactor)**: Drop `instance_prefix` entirely in Phase 1, replace with `event_id` + `booking_type` across all Edge Functions, frontend JS, and database RPCs.
2. **Option B (Dual-Write & Normalisation)**: Introduce `booking_type` as a normalised column, backfill existing rows from `instance_prefix`, and retain `instance_prefix` for ID generation and legacy API compatibility.

## Decision Outcome

Chosen **Option B**:
- Added `bookings.booking_type` (`food`, `general`, `misc`, `dev`) with a check constraint and index.
- Backfilled `booking_type` from `instance_prefix`.
- Retained `instance_prefix` on `bookings` for full backwards compatibility with ID allocation and public forms.
- Updated location conflict trigger (`booking_locations_check_conflict`) to query `event_id` and `booking_type` directly while preserving legacy `DEV` dataset isolation.

## Consequences

* **Positive**: 100% backwards compatibility preserved; no downtime or breaking API changes.
* **Negative**: Temporary duplication of data representation until Phase 3/4 completes full migration of public booking submission payloads.
