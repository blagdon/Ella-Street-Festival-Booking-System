-- payment_link_code has had a DEFAULT and a one-off backfill since
-- 20260731110000, and create-checkout-session already guards against a
-- null value before building a link. But nothing at the database level
-- stops a future direct insert (a bulk import, a manual fix, a bug in some
-- other migration) from slipping a NULL through — only the app-layer guard
-- would ever notice. Confirmed zero NULLs on production before adding this
-- (a one-off backfill only covers rows that existed at the time).

ALTER TABLE "public"."bookings"
  ALTER COLUMN "payment_link_code" SET NOT NULL;
