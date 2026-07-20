-- Constrain bookings.status to the six real statuses.
--
-- The status machine (Pending → Payment Requested → Confirmed, plus the
-- HCC Checks / Rejected / Cancelled branches) has only ever been enforced in
-- app code and RPC guards, while the column itself was unconstrained `text`.
-- A typo'd status from future code or a direct SQL fix would strand a booking
-- invisibly: every board and list filters by status, so a row with a status
-- nobody renders appears in no column at all.
--
-- WHY A CHECK CONSTRAINT AND NOT AN ENUM, despite is_charity having been
-- converted to one (booking_fee_type):
--   Postgres cannot remove a value from an enum type - there is no
--   ALTER TYPE ... DROP VALUE. This project's status set has churned
--   repeatedly: `Pre-Confirmed`, `Paid` and `On Hold` were each added and then
--   removed, some within days. As an enum, every one of those removals would
--   have required a full type-swap (create new type, alter column, re-point
--   dependants, drop old) instead of editing one line. is_charity was a good
--   enum candidate because Commercial/Charity/Not for profit is a stable set;
--   status demonstrably is not. A CHECK gets the same protection and stays
--   cheap to change the next time a status is added or retired.
--
-- Keep this list in sync with CONFIG.UI.STATUS_LIST in js/config.js, which is
-- the app-side source of truth (js/api.js validates against it before writing).
--
-- NOT NULL is included deliberately, slightly beyond the original finding: a
-- NULL status strands a booking in exactly the same way a typo'd one does, and
-- a CHECK alone would still permit it (SQL CHECK constraints pass on NULL).
-- Verified safe against live data before writing this: all 184 production
-- bookings hold one of the six values below and none is NULL, both writers set
-- status explicitly (submit-booking → 'Pending', insertMiscBooking →
-- 'Confirmed'), and the column already defaults to 'Pending' for anything that
-- omits it.
--
-- Adding a CHECK is atomic: if any row violated it the whole ALTER would fail
-- and leave the table untouched, so this cannot half-apply.

ALTER TABLE "public"."bookings"
  ALTER COLUMN "status" SET NOT NULL;

ALTER TABLE "public"."bookings"
  ADD CONSTRAINT "bookings_status_check"
  CHECK (("status" = ANY (ARRAY[
    'Pending'::"text",
    'Payment Requested'::"text",
    'Confirmed'::"text",
    'Rejected'::"text",
    'Cancelled'::"text",
    'HCC Checks'::"text"
  ])));
