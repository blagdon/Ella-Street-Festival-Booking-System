-- Migration: 20260801103_tenant_aware_rls_policies.sql
-- Phase 2 — Tenant Awareness & Normalisation: Step 3
--
-- Enables tenant-aware org_id resolution in get_current_org_id()
-- and updates RLS policies across domain tables to enforce tenant isolation.

-- 1. Dynamic get_current_org_id resolution
CREATE OR REPLACE FUNCTION "public"."get_current_org_id"()
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_jwt_claims text;
  v_org_id text;
BEGIN
  -- 1. Try reading custom claim 'org_id' from request JWT
  v_jwt_claims := nullif(current_setting('request.jwt.claims', true), '');
  IF v_jwt_claims IS NOT NULL THEN
    BEGIN
      v_org_id := nullif(v_jwt_claims::json ->> 'org_id', '');
      IF v_org_id IS NOT NULL THEN
        RETURN v_org_id;
      END IF;
    EXCEPTION WHEN others THEN
      NULL;
    END;
  END IF;

  -- 2. Fallback to organisation_members lookup for authenticated user
  IF auth.uid() IS NOT NULL THEN
    SELECT org_id INTO v_org_id
    FROM public.organisation_members
    WHERE user_id = auth.uid()
    LIMIT 1;
    IF v_org_id IS NOT NULL THEN
      RETURN v_org_id;
    END IF;
  END IF;

  -- 3. Fallback default
  RETURN 'org_default'::text;
END;
$$;

ALTER FUNCTION "public"."get_current_org_id"() OWNER TO postgres;

-- 2. Tenant isolation policies for organisations and events
CREATE POLICY "Users can read own organisation"
    ON "public"."organisations"
    FOR SELECT
    USING (id = get_current_org_id() OR check_user_role('admin'));

CREATE POLICY "Users can read own events"
    ON "public"."events"
    FOR SELECT
    USING (org_id = get_current_org_id() OR check_user_role('admin'));
