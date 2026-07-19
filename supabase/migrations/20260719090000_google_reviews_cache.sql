-- Server-side cache for the get-reviews Edge Function's SerpApi Google Maps
-- lookups. The booking detail pane auto-searches on every open (two metered
-- SerpApi calls each time: place search + reviews), so repeated opens of the
-- same booking burned quota for identical results. get-reviews now serves
-- fresh-enough entries from this table instead — see that function for the
-- TTL logic (default 7 days, overridable via the reviews_cache_ttl_hours
-- settings row) and the force-refresh bypass.
--
-- Access model mirrors stripe_webhook_events: RLS enabled with zero policies,
-- service_role only (the Edge Function runs as service_role, which bypasses
-- RLS). anon/authenticated get nothing — cached payloads are only ever
-- served through get-reviews' own admin-JWT check. The explicit by-name
-- revokes are belt-and-braces: this project's ALTER DEFAULT PRIVILEGES no
-- longer auto-grants anon/authenticated on new tables (20260717080000 /
-- 20260718120000), but stating it here keeps the intent auditable.

CREATE TABLE IF NOT EXISTS "public"."google_reviews_cache" (
    "business_key" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "fetched_at" timestamp with time zone NOT NULL DEFAULT "now"(),
    CONSTRAINT "google_reviews_cache_pkey" PRIMARY KEY ("business_key")
);

COMMENT ON TABLE "public"."google_reviews_cache" IS
  'Cached SerpApi Google Maps lookup results, keyed by normalized (lowercased/trimmed) business name. Written and read only by the get-reviews Edge Function (service_role). payload is the exact response body served to the client, including found:false results — those cost SerpApi calls too.';

ALTER TABLE "public"."google_reviews_cache" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."google_reviews_cache" FROM "anon", "authenticated";
GRANT ALL ON TABLE "public"."google_reviews_cache" TO "service_role";
