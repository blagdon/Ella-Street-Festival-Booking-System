-- Consolidate user_roles.role onto the pre-existing `user_role` enum type,
-- dropping the eq_text_user_role() operator shim this migration exists to
-- remove.
--
-- BACKGROUND (see HANDOVER.md's Gotchas entry on check_user_role()): a
-- `user_role` enum has existed alongside `user_roles.role text` since early in
-- this project. check_user_role(required_role user_role) compares
-- `role = required_role` — text = user_role, a cross-type comparison with no
-- built-in operator — so a custom `"public".=` operator backed by
-- eq_text_user_role() was created to make that resolve. The result: grepping
-- for eq_text_user_role's name finds no call site anywhere, because Postgres
-- invokes it by operator resolution, not by name. That invisibility is a
-- footgun for the next person who "cleans up" an apparently-unused function.
-- This migration removes the footgun by making role a genuine `user_role`,
-- so the comparison inside check_user_role becomes native enum = enum and the
-- shim has nothing left to do.
--
-- WHY AN ENUM HERE, having just argued AGAINST one for bookings.status
-- (20260720110000): the two cases are opposite on the one axis that matters.
-- Postgres cannot remove a value from an enum, so an enum is wrong for a
-- value set that churns (status has added and removed three labels). role's
-- value set ('admin', 'steward') has never changed and has no candidate
-- values pending - it wants the enum's structural guarantee (an invalid value
-- is not a data-quality bug waiting to be caught by a CHECK, it is a
-- statement Postgres physically cannot store), not a CHECK's flexibility.
--
-- WHAT ACTUALLY NEEDS TO CHANGE, established by tracing every reference to
-- user_roles.role in a live production dump before writing this, not by
-- assuming check_user_role() was the only call site:
--
--   - 7 policies call check_user_role('admin'::user_role) /
--     ('steward'::user_role). Their TEXT needs NO change and, more to the
--     point of what follows below, they register NO pg_depend dependency on
--     user_roles.role at all: a policy's dependency tracking covers the SQL
--     expression Postgres itself parses, and `check_user_role('admin'::user_role)`
--     is a function call with a literal argument - no column reference in
--     the policy expression. The column reference lives inside
--     check_user_role's plpgsql body, which is opaque to dependency tracking.
--     That's also why the function is re-planned fresh against the column's
--     current type at each execution and needs no CREATE OR REPLACE here.
--   - 1 policy ("policy_allow_all_admin" on user_roles) calls get_is_admin(),
--     same reasoning - no column dependency, no change needed.
--   - 6 policies inline `("user_roles"."role" = 'admin'::"text")` or
--     `= ANY (ARRAY['admin'::"text", 'steward'::"text"])` DIRECTLY in their
--     USING/WITH CHECK expression. These DO register a pg_depend dependency
--     on the column (Postgres parses and analyzes policy expressions), and
--     that dependency exists **regardless of what the literal is cast to** -
--     rewriting the cast from ::text to ::user_role via ALTER POLICY does not
--     remove it, which is not obvious until you hit it: the first version of
--     this migration did exactly that, then failed on the subsequent
--     ALTER COLUMN TYPE with "cannot alter type of a column used in a policy
--     definition", for a policy that had already been rewritten to reference
--     the NEW type. The dependency is on the column, full stop, independent
--     of the comparison's type. The only way to clear it is DROP POLICY then
--     CREATE POLICY fresh after the column has changed type - not ALTER
--     POLICY, which edits the expression in place without ever dropping the
--     underlying dependency record.
--
-- Confirmed empirically (rolled back cleanly on the test project, verified
-- via a fresh dump showing the original text column and CHECK constraint
-- both still present) before writing this corrected version - the whole
-- migration runs as one transaction, so the failed first attempt left nothing
-- half-applied anywhere.
--
-- Verified against live data before writing this: production currently holds
-- 4 user_roles rows, all role='admin' (no steward account exists right now),
-- and the pre-existing CHECK constraint already guaranteed no other value was
-- ever stored - so `role::"public"."user_role"` cannot fail on current data.

-- The old CHECK is redundant with (and structurally weaker than) the enum
-- constraint it's being replaced by; its ARRAY['admin'::text, ...] expression
-- also can't remain as-is against an enum column.
ALTER TABLE "public"."user_roles" DROP CONSTRAINT "user_roles_role_check";

-- Drop the six policies that reference user_roles.role directly, so the
-- column has no dependent policies left when the type change runs below.
DROP POLICY "Admin manage email_templates" ON "public"."email_templates";
DROP POLICY "Allow admins full access to booking_locations" ON "public"."booking_locations";
DROP POLICY "Allow admins full access to settings" ON "public"."settings";
DROP POLICY "Allow staff to read booking_locations" ON "public"."booking_locations";
DROP POLICY "performer_admin_access" ON "public"."performers";
DROP POLICY "schedule_admin_access" ON "public"."schedules";

-- The actual type change. `role::"public"."user_role"` uses the enum's
-- automatic text-input cast (available for any explicit `::` cast, this is
-- not something that needed to be defined specially) - safe here because
-- every existing value already matches an enum label exactly, per the
-- CHECK constraint just dropped and the live-data check above.
ALTER TABLE "public"."user_roles"
  ALTER COLUMN "role" TYPE "public"."user_role" USING "role"::"public"."user_role";

-- Recreate the six policies against the now-enum column, casting to
-- user_role instead of text - explicitly, rather than dropping the cast and
-- relying on unknown-literal inference, so the policy text itself states its
-- own type rather than leaving it to inference (the same complaint this
-- migration is fixing for check_user_role, applied consistently). Same
-- TO/FOR/USING/WITH CHECK shape as before in every case; only the cast changed.
CREATE POLICY "Admin manage email_templates" ON "public"."email_templates"
  TO "authenticated"
  USING ((EXISTS ( SELECT 1
    FROM "public"."user_roles"
    WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"public"."user_role")))))
  WITH CHECK ((EXISTS ( SELECT 1
    FROM "public"."user_roles"
    WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"public"."user_role")))));

CREATE POLICY "Allow admins full access to booking_locations" ON "public"."booking_locations"
  TO "authenticated"
  USING ((EXISTS ( SELECT 1
    FROM "public"."user_roles"
    WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"public"."user_role")))))
  WITH CHECK ((EXISTS ( SELECT 1
    FROM "public"."user_roles"
    WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"public"."user_role")))));

CREATE POLICY "Allow admins full access to settings" ON "public"."settings"
  TO "authenticated"
  USING ((EXISTS ( SELECT 1
    FROM "public"."user_roles"
    WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"public"."user_role")))))
  WITH CHECK ((EXISTS ( SELECT 1
    FROM "public"."user_roles"
    WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"public"."user_role")))));

CREATE POLICY "Allow staff to read booking_locations" ON "public"."booking_locations"
  FOR SELECT TO "authenticated"
  USING ((EXISTS ( SELECT 1
    FROM "public"."user_roles"
    WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = ANY (ARRAY['admin'::"public"."user_role", 'steward'::"public"."user_role"]))))));

CREATE POLICY "performer_admin_access" ON "public"."performers"
  TO "authenticated"
  USING ((EXISTS ( SELECT 1
    FROM "public"."user_roles"
    WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"public"."user_role")))));

CREATE POLICY "schedule_admin_access" ON "public"."schedules"
  TO "authenticated"
  USING ((EXISTS ( SELECT 1
    FROM "public"."user_roles"
    WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"public"."user_role")))));

-- Now genuinely orphaned - drop the operator before the function it depends
-- on (CREATE OPERATOR registers a dependency on its backing function, so the
-- function cannot be dropped first).
DROP OPERATOR IF EXISTS "public".= ("text", "public"."user_role");
DROP FUNCTION IF EXISTS "public"."eq_text_user_role"("text", "public"."user_role");
