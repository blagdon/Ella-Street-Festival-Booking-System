-- Migration: 20260802001_rpc_add_organisation_member.sql
-- Epic 2 Platform Administration: Safe member addition & role management with auth.users lookup and pending signup trigger.

-- 1. Drop FK constraint on user_roles.id to allow inviting members before auth signup
ALTER TABLE "public"."user_roles" DROP CONSTRAINT IF EXISTS "user_roles_id_fkey";

-- 2. Create SECURITY DEFINER RPC to look up auth.users and add member safely
CREATE OR REPLACE FUNCTION "public"."rpc_add_organisation_member"(
    p_email text,
    p_role text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id uuid;
    v_org_id text := get_current_org_id();
    v_role_enum user_role;
BEGIN
    -- Authorization check: caller must be admin
    IF NOT check_user_role('admin') THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required';
    END IF;

    IF p_email IS NULL OR trim(p_email) = '' THEN
        RAISE EXCEPTION 'User email address is required';
    END IF;

    IF p_role NOT IN ('admin', 'steward') THEN
        RAISE EXCEPTION 'Invalid role: %', p_role;
    END IF;

    v_role_enum := p_role::user_role;

    -- Look up auth.users by email
    SELECT id INTO v_user_id
    FROM auth.users
    WHERE lower(email) = lower(trim(p_email))
    LIMIT 1;

    -- If not found in auth.users, check existing user_roles for an already assigned ID
    IF v_user_id IS NULL THEN
        SELECT id INTO v_user_id
        FROM public.user_roles
        WHERE lower(email) = lower(trim(p_email))
        LIMIT 1;
    END IF;

    -- If still null, generate a new UUID for pending user
    IF v_user_id IS NULL THEN
        v_user_id := gen_random_uuid();
    END IF;

    -- Upsert user_roles
    INSERT INTO public.user_roles (id, email, role)
    VALUES (v_user_id, lower(trim(p_email)), v_role_enum)
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, email = EXCLUDED.email;

    -- Upsert organisation_members
    INSERT INTO public.organisation_members (org_id, user_id, role)
    VALUES (v_org_id, v_user_id, p_role)
    ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role;

    RETURN jsonb_build_object(
        'status', 'success',
        'user_id', v_user_id,
        'email', lower(trim(p_email)),
        'role', p_role
    );
END;
$$;

GRANT EXECUTE ON FUNCTION "public"."rpc_add_organisation_member"(text, text) TO authenticated;

-- 3. Trigger on auth.users to automatically link user_roles and organisation_members when a user signs up
CREATE OR REPLACE FUNCTION "public"."link_pending_user_roles_on_signup"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    UPDATE public.user_roles
    SET id = NEW.id
    WHERE lower(email) = lower(NEW.email) AND id <> NEW.id;

    UPDATE public.organisation_members
    SET user_id = NEW.id
    WHERE user_id IN (
        SELECT id FROM public.user_roles WHERE lower(email) = lower(NEW.email)
    );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_link_pending_user_roles" ON auth.users;
CREATE TRIGGER "trg_link_pending_user_roles"
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION "public"."link_pending_user_roles_on_signup"();
