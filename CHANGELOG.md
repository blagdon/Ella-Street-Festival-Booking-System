# Changelog

All notable changes to this project are documented in this file.

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
