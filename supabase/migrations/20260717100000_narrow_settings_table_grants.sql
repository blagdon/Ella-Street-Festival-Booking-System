-- settings had GRANT ALL to anon and authenticated at the table level, with
-- RLS doing all the narrowing: anon's policy is SELECT-only over an explicit
-- key allowlist, authenticated's is admin-only full access. That works and is
-- tested, but it leaves the RLS policy as a single point of failure - a bad
-- policy edit (or an accidental DISABLE ROW LEVEL SECURITY during debugging)
-- would instantly hand anon INSERT/UPDATE/DELETE on the table that stores the
-- Zoho/Stripe/SerpAPI credentials. Narrowing the table grant to what each
-- role's policy can actually allow through makes the grant a second,
-- independent layer instead.
--
--   anon: SELECT only. config.js, supabase-public.js, and the public booking
--     pages read the allowlisted keys; nothing anon-side ever writes
--     (confirmed by grep of every .from('settings') call site).
--
--   authenticated: SELECT, INSERT, UPDATE. The admin settings UI
--     (js/page-settings.js) only selects and upserts (upsert needs
--     INSERT + UPDATE). Nothing authenticated-side deletes settings rows -
--     only tests do, via service_role, which is untouched here. If an
--     admin-facing delete feature ever appears, DELETE gets granted back in
--     that feature's own migration.
--
-- RLS policies themselves are unchanged - this is defense-in-depth, not a
-- behavior change. Sequences are not involved (settings has a text key, no
-- serial column).

REVOKE ALL ON TABLE "public"."settings" FROM "anon";
GRANT SELECT ON TABLE "public"."settings" TO "anon";

REVOKE ALL ON TABLE "public"."settings" FROM "authenticated";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."settings" TO "authenticated";
