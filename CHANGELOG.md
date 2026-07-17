# Changelog

All notable changes to this project are documented in this file.

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
