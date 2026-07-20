-- Make audit_logs.user_email trustworthy by stamping it server-side.
--
-- The insert policy is `WITH CHECK (true)` and js/api.js's auditLog() supplies
-- user_email as ordinary client-controlled text, so any authenticated staff
-- account could write audit entries attributed to somebody else. An audit
-- trail that the people it audits can forge is worth much less than it
-- appears, and this project leans on it: audit_log.html browses it, and most
-- mutating features write to it.
--
-- Fix: a BEFORE INSERT trigger overwrites user_email with the email claim from
-- the request's JWT, mirroring how `verified_by` is already server-derived for
-- bank-transfer payments rather than trusted from the client.
--
-- TWO DELIBERATE DESIGN CHOICES, both load-bearing:
--
-- 1. It OVERWRITES rather than rejects. In normal operation the client already
--    sends its own session email, so this is a no-op; rejecting on mismatch
--    would turn a silent correction into a broken feature for no extra safety.
--
-- 2. It only overwrites WHEN A CLAIM EXISTS. Edge Functions insert audit rows
--    as service_role, whose JWT carries no email claim - overwriting
--    unconditionally would blank those rows, and rejecting would break server
--    -side logging outright. So a request with no email claim keeps whatever
--    the caller supplied.
--
-- Reads request.jwt.claims directly rather than calling auth.jwt(): the
-- function is SECURITY INVOKER, so it would need the calling role to hold
-- EXECUTE on auth.jwt(), and audit logging silently failing would be a worse
-- outcome than the spoofing this prevents. current_setting() is a pg_catalog
-- builtin and always resolvable, including under `search_path = ''`.
--
-- Malformed claims are swallowed for the same reason - this trigger must never
-- be the thing that stops a write from being recorded.

CREATE OR REPLACE FUNCTION "public"."stamp_audit_log_user_email"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  claims text;
  jwt_email text;
BEGIN
  claims := nullif(current_setting('request.jwt.claims', true), '');

  IF claims IS NOT NULL THEN
    BEGIN
      jwt_email := nullif(claims::json ->> 'email', '');
    EXCEPTION WHEN others THEN
      jwt_email := NULL;
    END;
  END IF;

  IF jwt_email IS NOT NULL THEN
    NEW."user_email" := jwt_email;
  END IF;

  RETURN NEW;
END;
$$;

-- Revoked by name, not just FROM PUBLIC: this schema's ALTER DEFAULT
-- PRIVILEGES history means a PUBLIC-only revoke has silently failed to cover
-- these roles before (see the Gotchas entry on that). A trigger function needs
-- no EXECUTE grant to fire - permission is checked on the table.
REVOKE ALL ON FUNCTION "public"."stamp_audit_log_user_email"() FROM "anon", "authenticated";

DROP TRIGGER IF EXISTS "stamp_audit_log_user_email" ON "public"."audit_logs";
CREATE TRIGGER "stamp_audit_log_user_email"
  BEFORE INSERT ON "public"."audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "public"."stamp_audit_log_user_email"();
