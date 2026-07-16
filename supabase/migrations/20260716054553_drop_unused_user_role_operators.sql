-- EXPERIMENTAL - test project only for now, not yet applied live.
--
-- Investigating whether 3 of the 4 custom text/user_role comparison
-- operators (and their backing functions) are actually dead. Reasoning:
-- check_user_role()'s body does `role = required_role`, where `role`
-- (public.user_roles.role) is text and `required_role` is a user_role
-- parameter - that specific expression is what invokes the "=" (text,
-- user_role) operator (backed by eq_text_user_role) on every single RLS
-- check across this schema, since Postgres picks the exact-type-match
-- operator. That one stays.
--
-- The other three appear genuinely unreachable: public.user_role is never
-- used as a column type anywhere in this schema (only as a function
-- parameter), nothing anywhere reverses the comparison order (user_role =
-- text), and nothing anywhere uses <> between these two types. So:
--   - "=" (user_role, text)   [eq_user_role_text]  - reversed order, unused
--   - "<>" (text, user_role)  [neq_text_user_role]  - never negated
--   - "<>" (user_role, text)  [neq_user_role_text]  - never negated, reversed
--
-- Dropping operators before their backing functions (required - a function
-- can't be dropped while an operator still depends on it). The two "<>"
-- operators are each other's COMMUTATOR and are dropped together, so
-- there's no dangling reference. Dropping "=" (user_role, text) will clear
-- the surviving "=" (text, user_role) operator's COMMUTATOR link
-- automatically (standard Postgres behavior when a commutator partner is
-- dropped) - this only removes a query-planner optimization hint, it does
-- not affect correctness of the operator that check_user_role() actually
-- uses.
--
-- Verify via the full test suite (exercises check_user_role via RLS on
-- nearly every admin action) before ever considering this for the live
-- project.
DROP OPERATOR IF EXISTS "public".<> ("text", "public"."user_role");
DROP OPERATOR IF EXISTS "public".<> ("public"."user_role", "text");
DROP OPERATOR IF EXISTS "public".= ("public"."user_role", "text");

DROP FUNCTION IF EXISTS "public"."neq_text_user_role"("text", "public"."user_role");
DROP FUNCTION IF EXISTS "public"."neq_user_role_text"("public"."user_role", "text");
DROP FUNCTION IF EXISTS "public"."eq_user_role_text"("public"."user_role", "text");
