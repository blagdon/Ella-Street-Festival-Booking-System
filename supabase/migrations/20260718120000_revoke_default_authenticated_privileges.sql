-- Mirrors 20260717080000's anon fix for authenticated: this project's
-- schema-level ALTER DEFAULT PRIVILEGES was only ever narrowed for anon,
-- leaving authenticated still auto-granted ALL on every new
-- function/table/sequence at creation time (confirmed live via
-- pg_default_acl: postgres=X/postgres,authenticated=X/postgres for
-- functions; arwdDxtm for tables; rwU for sequences - i.e. authenticated
-- gets essentially everything by default, same gap anon had).
--
-- Every migration in this project already explicitly GRANTs authenticated
-- exactly what it needs on any new object it creates (confirmed across
-- every migration this session touched - rpc_get_next_misc_id,
-- rpc_record_bank_transfer_payment, the settings/payments/anon/authenticated
-- table-narrowing migrations, etc. all state their authenticated grant by
-- hand), so this default was already redundant in practice - it just meant
-- a future migration that forgot the explicit grant would silently get full
-- access anyway instead of failing loudly. Closing the same gap for
-- authenticated that 20260717080000 already closed for anon.
--
-- Non-retroactive, same as the anon fix: this only changes what happens at
-- CREATE time from now on. It does not touch any existing grant - the
-- three anon/authenticated table-narrowing migrations already applied
-- (20260718090000, 20260718100000, 20260718110000) stay exactly as they
-- are. Any future function/table/sequence that needs authenticated access
-- needs an explicit GRANT in its own migration from here on - already how
-- every migration in this project has actually been written.

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON FUNCTIONS FROM "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "authenticated";
