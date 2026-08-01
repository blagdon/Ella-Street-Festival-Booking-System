-- Migration: 20260801104_allow_admins_manage_organisations_and_events.sql
-- Epic 2 Platform Administration: Allow admin role to create/update organisations and events.

-- 1. Table Grants for authenticated role
GRANT ALL ON TABLE "public"."organisations" TO authenticated;
GRANT ALL ON TABLE "public"."events" TO authenticated;
GRANT ALL ON TABLE "public"."organisation_members" TO authenticated;

-- 2. RLS Policies for organisations (Admins full access)
DROP POLICY IF EXISTS "Admins can manage organisations" ON "public"."organisations";
CREATE POLICY "Admins can manage organisations"
    ON "public"."organisations"
    FOR ALL
    TO authenticated
    USING (check_user_role('admin'))
    WITH CHECK (check_user_role('admin'));

-- 3. RLS Policies for events (Admins full access)
DROP POLICY IF EXISTS "Admins can manage events" ON "public"."events";
CREATE POLICY "Admins can manage events"
    ON "public"."events"
    FOR ALL
    TO authenticated
    USING (check_user_role('admin'))
    WITH CHECK (check_user_role('admin'));

-- 4. RLS Policies for organisation_members (Admins full access)
DROP POLICY IF EXISTS "Admins can manage organisation_members" ON "public"."organisation_members";
CREATE POLICY "Admins can manage organisation_members"
    ON "public"."organisation_members"
    FOR ALL
    TO authenticated
    USING (check_user_role('admin'))
    WITH CHECK (check_user_role('admin'));
