-- Follow-up to item 60 (20260720130000): consolidate get_is_admin() into
-- check_user_role('admin'::user_role), finishing what that migration started
-- — one canonical admin-check mechanism instead of two parallel ones.
--
-- get_is_admin() and check_user_role('admin'::user_role) were behaviourally
-- identical: both SECURITY DEFINER, both `SELECT 1 FROM user_roles WHERE
-- id = auth.uid() AND role = 'admin'` in substance, the only difference being
-- one hardcodes 'admin' and the other takes it as a parameter. Two functions
-- doing the same admin check, discovered as a side effect of tracing every
-- reference to user_roles.role for item 60 — get_is_admin() has exactly one
-- call site anywhere (policy_allow_all_admin on user_roles itself), confirmed
-- by grepping every function body in a live production dump for an embedded
-- call (not just pg_depend, which wouldn't show this either way — plpgsql
-- bodies are opaque to it, the same reason check_user_role's own internal
-- reference to user_roles.role was invisible to dependency tracking) and by
-- checking client/RPC code for the name directly.
--
-- SAFE TO ALTER POLICY IN PLACE HERE, unlike the six policies in 20260720130000
-- that needed DROP+CREATE: this is not that trap. The pg_depend issue there
-- was specifically about a policy expression referencing a COLUMN directly
-- (`user_roles.role = ...`) — the column dependency persists post-ALTER
-- because the rewritten expression *still references the same column*, not
-- because ALTER POLICY fails to update dependencies generally. Both the old
-- expression here (`get_is_admin()`) and the new one
-- (`check_user_role('admin'::user_role)`) are plain function calls with no
-- column reference in the policy expression itself — ALTER POLICY correctly
-- re-points the policy's function dependency from one to the other, and
-- get_is_admin() is left with zero dependents, safe to drop immediately after.
-- Verified on the test project before applying to production, given this
-- exact kind of unverified assumption was wrong once already on item 60's
-- first attempt.

ALTER POLICY "policy_allow_all_admin" ON "public"."user_roles"
  USING ("public"."check_user_role"('admin'::"public"."user_role"))
  WITH CHECK ("public"."check_user_role"('admin'::"public"."user_role"));

DROP FUNCTION IF EXISTS "public"."get_is_admin"();
