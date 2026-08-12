import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * Resolves the document storage bucket name: env var takes priority if set,
 * otherwise falls back to the calling organisation's own settings-table
 * value, so changing the bucket there takes effect everywhere. Shared by
 * submit-booking (writes) and get-booking-documents (reads) so both agree
 * on the same bucket without duplicating the lookup.
 *
 * orgId is required, not defaulted (unlike loadStripeSettings' org_default
 * default) - the settings table's (org_id, key) primary key means an
 * unscoped lookup here previously either errored or, worse, silently
 * discarded that error and returned the hardcoded fallback for every
 * caller once a second organisation's row existed (E5-01). maybeSingle(),
 * not single(): the composite key guarantees at most one row for this
 * org+key, so "no row yet" (a new org that hasn't set one) is a normal,
 * expected case, not an error.
 */
export async function getBucketName(supabaseAdmin: ReturnType<typeof createClient>, orgId: string): Promise<string> {
  const envBucket = Deno.env.get('BUCKET_NAME')
  if (envBucket) return envBucket

  const { data: bucketSetting } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('org_id', orgId)
    .eq('key', 'bucket_name')
    .maybeSingle()

  return bucketSetting?.value || 'esf-documents'
}
