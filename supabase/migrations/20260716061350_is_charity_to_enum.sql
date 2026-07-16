-- Converts bookings.is_charity from free text to a native enum, flagged
-- during a schema review. is_charity is a genuine tri-state
-- ('Commercial'/'Charity'/'Not for profit'), not boolean - a boolean
-- replacement was considered and rejected earlier in the same review
-- (it would collapse "Charity" and "Not for profit" into the same value,
-- destroying a distinction js/kanban.js's confirm-booking logic actively
-- relies on). This enum is a low-churn set (unlike bookings.status, which
-- changed four times in one day earlier this session) - see this
-- project's performers.status column (public.performer_status enum) for a
-- working precedent already in this exact schema: PostgREST serializes
-- enum columns as plain JSON strings and accepts plain strings on write,
-- so no application code needs to change for this - js/kanban.js's
-- `booking.is_charity === 'Charity'` comparisons keep working exactly as
-- they do today.
--
-- The old text DEFAULT must be dropped before the column's type can
-- change (Postgres cannot implicitly re-cast a text default expression to
-- an enum type), then re-added afterward with the new type. The
-- `USING is_charity::text::"booking_fee_type"` cast will fail the entire
-- statement (atomically - no partial conversion, nothing corrupted) if
-- any existing row holds a value outside the three labels below; NULL is
-- fine since the column has no NOT NULL constraint and enums support NULL
-- like any other type.
CREATE TYPE "public"."booking_fee_type" AS ENUM (
    'Commercial',
    'Charity',
    'Not for profit'
);

ALTER TABLE "public"."bookings" ALTER COLUMN "is_charity" DROP DEFAULT;

ALTER TABLE "public"."bookings"
    ALTER COLUMN "is_charity" TYPE "public"."booking_fee_type"
    USING "is_charity"::"text"::"public"."booking_fee_type";

ALTER TABLE "public"."bookings" ALTER COLUMN "is_charity" SET DEFAULT 'Commercial'::"public"."booking_fee_type";
