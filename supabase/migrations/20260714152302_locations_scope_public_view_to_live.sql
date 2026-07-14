-- Drop the redundant anon SELECT policy on locations and scope the
-- surviving one to dataset='LIVE'.
--
-- This should have been a migration from the start — it was mistakenly done
-- as a root-level fix file instead (fix_locations_redundant_anon_policy.sql),
-- breaking the convention this same series of migrations established
-- ("public-schema RLS changes use a migration, not a new fix file"). Already
-- applied live via that fix file; this migration exists so a fresh replay of
-- the migration history (baseline -> this) ends up in the same state as the
-- live project, rather than the baseline's original unscoped/duplicate
-- policy. See fix_locations_redundant_anon_policy.sql for the full
-- reasoning (severity, why LIVE-only is correct).
DROP POLICY IF EXISTS anon_select_locations ON public.locations;
DROP POLICY IF EXISTS "Public view locations" ON public.locations;

CREATE POLICY "Public view locations" ON public.locations
FOR SELECT USING (dataset = 'LIVE');
