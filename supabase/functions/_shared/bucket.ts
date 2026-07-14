import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * Resolves the document storage bucket name: env var takes priority if set,
 * otherwise falls back to the same settings-table value the admin Settings
 * page manages, so changing the bucket there takes effect everywhere.
 * Shared by submit-booking (writes) and get-booking-documents (reads) so
 * both agree on the same bucket without duplicating the lookup.
 */
export async function getBucketName(supabaseAdmin: ReturnType<typeof createClient>): Promise<string> {
  const envBucket = Deno.env.get('BUCKET_NAME')
  if (envBucket) return envBucket

  const { data: bucketSetting } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', 'bucket_name')
    .single()

  return bucketSetting?.value || 'esf-documents'
}
