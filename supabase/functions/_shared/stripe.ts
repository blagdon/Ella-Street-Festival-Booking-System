import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@17.5.0?target=deno'

/**
 * Single import point for the Stripe SDK plus the test/live mode
 * resolution shared by create-checkout-session and stripe-webhook.
 *
 * All four Stripe credentials (secret key + webhook signing secret, one
 * pair per mode) live in the `settings` DB table, admin-editable via
 * settings.html's "Stripe Payments" card — same pattern as the Zoho
 * credentials in _shared/zoho.ts, and deliberately NOT Edge Function env
 * vars, so an admin can rotate/configure them without CLI access or a
 * redeploy. Keys: `stripe_secret_key_test`, `stripe_secret_key_live`,
 * `stripe_webhook_secret_test`, `stripe_webhook_secret_live`. None of these
 * are in the `settings` RLS policy's anon-readable whitelist (same
 * protection level as zoho_* — admin/service_role only).
 *
 * Mode is keyed off bookings.instance_prefix, mirroring this repo's existing
 * DEV-vs-LIVE convention (locations.dataset, fetchPayments' instance
 * filtering, etc.): the DEV instance always uses Stripe Test mode,
 * regardless of the setting below. FOOD/NONFOOD/MISC ("Food/General") use
 * Live mode by default, UNLESS the admin-editable `stripe_test_mode`
 * settings-table row (toggle on settings.html, boolean as text 'true'/
 * 'false') is 'true' — turning that on forces Test mode for Food/General
 * bookings too (e.g. a full rehearsal before going live with real
 * payments). There is no partial/silent fallback for a missing credential —
 * a missing value for the resolved mode is a configuration error and throws
 * loudly rather than pretending to work.
 */
export type StripeMode = 'test' | 'live'

export interface StripeSettings {
  secretKeyTest: string | null
  secretKeyLive: string | null
  webhookSecretTest: string | null
  webhookSecretLive: string | null
  testModeSetting: boolean
}

const STRIPE_SETTINGS_KEYS = [
  'stripe_secret_key_test',
  'stripe_secret_key_live',
  'stripe_webhook_secret_test',
  'stripe_webhook_secret_live',
  'stripe_test_mode'
]

export async function loadStripeSettings(supabaseAdmin: ReturnType<typeof createClient>): Promise<StripeSettings> {
  const { data, error } = await supabaseAdmin
    .from('settings')
    .select('key, value')
    .in('key', STRIPE_SETTINGS_KEYS)

  if (error) {
    throw new Error('Failed to load Stripe settings from database: ' + error.message)
  }

  const map: Record<string, string> = {}
  ;(data || []).forEach((row: any) => { map[row.key] = row.value })

  return {
    secretKeyTest: map['stripe_secret_key_test'] || null,
    secretKeyLive: map['stripe_secret_key_live'] || null,
    webhookSecretTest: map['stripe_webhook_secret_test'] || null,
    webhookSecretLive: map['stripe_webhook_secret_live'] || null,
    testModeSetting: map['stripe_test_mode'] === 'true'
  }
}

export function resolveStripeMode(instancePrefix: string | null | undefined, forceTestModeSetting: boolean = false): StripeMode {
  if ((instancePrefix || '').includes('-DEV-')) return 'test'
  return forceTestModeSetting ? 'test' : 'live'
}

export function getStripeSecretKey(mode: StripeMode, settings: StripeSettings): string {
  const key = mode === 'test' ? settings.secretKeyTest : settings.secretKeyLive
  if (!key) {
    throw new Error(`stripe_secret_key_${mode} is not configured in the settings table (settings.html → Stripe Payments).`)
  }
  return key
}

export function getStripeWebhookSecret(mode: StripeMode, settings: StripeSettings): string {
  const secret = mode === 'test' ? settings.webhookSecretTest : settings.webhookSecretLive
  if (!secret) {
    throw new Error(`stripe_webhook_secret_${mode} is not configured in the settings table (settings.html → Stripe Payments).`)
  }
  return secret
}

export function getStripeClient(mode: StripeMode, settings: StripeSettings): Stripe {
  return new Stripe(getStripeSecretKey(mode, settings), {
    apiVersion: '2024-06-20',
    httpClient: Stripe.createFetchHttpClient()
  })
}
