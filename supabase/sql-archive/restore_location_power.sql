-- RESTORE SCRIPT for the dropped `location_power` table.
--
-- location_power was dropped from production on 2026-07-20 (migration
-- 20260720120000_drop_location_power.sql) after the project owner confirmed it
-- was orphaned. This file exists so that decision is reversible: run it in the
-- SQL Editor to recreate the table, its policies, its grants and its exact
-- contents as they were at the moment of the drop.
--
-- WHY YOU MIGHT NEED THIS: the table's own COMMENT described it as "Power
-- availability at each performance location", and its rows are performer venue
-- names (Music Stage, Beach, Green, After party, On the street) rather than
-- stall pitch ids. The performers feature is shared with a SEPARATE app
-- (ellafestperformersadmin.vercel.app) that this repo cannot audit - see
-- HANDOVER.md's warning about that consumer. If that app turns out to read or
-- write this table, this script restores it exactly.
--
-- Data captured from a live production dump immediately before the drop.
-- Note the fifth row is internally inconsistent as recorded - `Green` has
-- power_available = true while its note reads "No power available". Preserved
-- verbatim rather than corrected, because this is an archive of what was
-- actually there, not what it should have said.

CREATE TABLE IF NOT EXISTS "public"."location_power" (
    "power_available" boolean DEFAULT false NOT NULL,
    "max_capacity" integer,
    "notes" "text",
    "location" "text"
);

ALTER TABLE "public"."location_power" OWNER TO "postgres";

COMMENT ON TABLE "public"."location_power" IS 'Power availability at each performance location';

ALTER TABLE "public"."location_power" ENABLE ROW LEVEL SECURITY;

-- Original policies, reproduced as they were.
CREATE POLICY "Public view power" ON "public"."location_power"
  FOR SELECT TO "authenticated", "anon" USING (true);

CREATE POLICY "Admin manage location_power" ON "public"."location_power"
  TO "authenticated" USING ((EXISTS (
    SELECT 1 FROM "public"."user_roles"
    WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"text"))
  )));

-- Original grants (anon/authenticated were SELECT-only after the 2026-07-18
-- table-grant narrowing; service_role held ALL).
GRANT ALL ON TABLE "public"."location_power" TO "service_role";
GRANT SELECT ON TABLE "public"."location_power" TO "anon";
GRANT SELECT ON TABLE "public"."location_power" TO "authenticated";

-- Contents at the time of the drop (5 rows).
INSERT INTO "public"."location_power" ("power_available", "max_capacity", "notes", "location") VALUES
  (true,  NULL, 'Full PA system and power available',    'Music Stage'),
  (false, NULL, 'No power available - acoustic only',    'On the street'),
  (false, NULL, 'No power infrastructure',               'Beach'),
  (true,  NULL, 'Indoor venue with full power',          'After party'),
  (true,  NULL, 'No power available',                    'Green');
