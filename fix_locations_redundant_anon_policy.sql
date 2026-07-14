-- ===================================================================
-- FIX: drop redundant anon SELECT policy on locations, scope to LIVE
-- Run this script in the Supabase SQL Editor (https://supabase.com)
--
-- public.locations has two separate RLS policies granting identical
-- unrestricted SELECT access ("Public view locations", "anon_select_locations",
-- both USING (true), neither with a TO clause so both apply to every role).
-- Low severity — no PII, just pitch coordinates/power flag, and LIVE rows are
-- meant to be public anyway (the visitor map shows them on purpose) — but the
-- duplication is pure redundancy that makes a future RLS audit slower (two
-- policies doing the same thing, easy to wrongly assume one is more
-- restrictive), and the one unintended bit is that DEV-dataset rows are
-- publicly queryable too, revealing where test/dev pitches are laid out to
-- anyone hitting the API directly rather than through the map UI.
--
-- Fix: drop the duplicate, and scope the surviving policy to dataset='LIVE'
-- so DEV rows stop being publicly queryable while the actual public-map use
-- case (LIVE locations) is untouched.
-- ===================================================================

DROP POLICY IF EXISTS anon_select_locations ON public.locations;
DROP POLICY IF EXISTS "Public view locations" ON public.locations;

CREATE POLICY "Public view locations" ON public.locations
FOR SELECT USING (dataset = 'LIVE');

-- ===================================================================
-- VERIFY:
--   SELECT policyname, roles, cmd, qual FROM pg_policies
--   WHERE schemaname = 'public' AND tablename = 'locations';
--   -- should show exactly two policies: "Admin manage locations" (unchanged)
--   -- and "Public view locations" with qual = (dataset = 'LIVE'::text).
--   -- "anon_select_locations" should no longer appear.
-- ===================================================================
