-- Two fixes from a full permission audit across bookings/payments/locations/
-- performers/schedules/users/audit_logs, requested after the owner flagged
-- access control as the most likely source of future issues as the system
-- grows. Both predate this session's own work - undocumented anywhere,
-- confirmed not deliberate.

-- 1. performers: "Public can view scheduled" and "Public row-level access
-- for views" both match status IN ('Scheduled','Paid') for anon, but only
-- the second also requires deleted_at IS NULL. RLS policies are OR'd
-- together, so the first policy's absence of that check fully neutralizes
-- the second's - a soft-deleted performer (deleted_at set by the separate
-- ellafestperformersadmin.vercel.app app, which owns that column; this repo
-- never writes it) stays publicly visible via the first policy regardless.
-- Fix: fold the deleted_at check into the one policy that actually matters
-- (it covers both authenticated and anon), then drop the now-fully-
-- redundant anon-only policy instead of leaving two ways to say one thing.
DROP POLICY IF EXISTS "Public can view scheduled" ON "public"."performers";
CREATE POLICY "Public can view scheduled" ON "public"."performers" FOR SELECT TO "authenticated", "anon"
    USING ((("status" = ANY (ARRAY['Scheduled'::"public"."performer_status", 'Paid'::"public"."performer_status"])) AND ("deleted_at" IS NULL)));

DROP POLICY IF EXISTS "Public row-level access for views" ON "public"."performers";

-- 2. audit_logs: three separate INSERT policies land on the same outcome
-- ("Allow authenticated users to insert audit logs" and "auth_insert_audit"
-- are byte-for-byte identical; "Auth system log" is a no-op for anon since
-- auth.uid() is null for a genuine unauthenticated request). Not a security
-- hole - all three are equally permissive - but exactly the kind of clutter
-- that causes a future mistake: someone drops one policy believing they've
-- tightened access, not realizing two others still allow it. Keep the one
-- with the clearest name, drop the other two.
DROP POLICY IF EXISTS "auth_insert_audit" ON "public"."audit_logs";
DROP POLICY IF EXISTS "Auth system log" ON "public"."audit_logs";
