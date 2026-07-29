import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * Provider-agnostic SMS sender, the SMS counterpart to _shared/zoho.ts.
 *
 * Called in-process (no HTTP hop) from send-sms, queue-bulk-sms's background
 * drain loop, and retry-queued-sms — the same "call the shared sender directly
 * rather than invoking a sibling Edge Function 50+ times" pattern the email
 * path uses (see zoho.ts's docstring for the fetch-level failure mode that
 * avoids, and the pre-commit hook that enforces it).
 *
 * WHY PROVIDER-AGNOSTIC: no SMS provider has been signed up yet, so this
 * dispatches on the `sms_provider` settings row to one of several adapters and
 * ships with 'mock' as the default — the full queue pipeline runs end-to-end
 * (Pending -> Sent) with no account and no credentials, and swapping to a real
 * provider is changing one settings value plus filling in its credentials.
 *
 * To add a provider: write a `sendVia<Name>` adapter with the SmsAdapter
 * signature and add a case to the switch in sendViaSms(). Nothing else changes.
 */

export interface SmsSendResult {
  success: true
  providerMessageId: string | null
  segments: number
  provider: string
}

interface SmsSettings {
  provider: string
  senderId: string
  defaultCountry: string
  apiKey: string        // generic bearer / JWT (e.g. The SMS Works customer JWT)
  apiSecret: string     // provider secondary secret (e.g. Twilio auth token)
  accountSid: string    // provider account id (e.g. Twilio Account SID)
  apiUrl: string        // optional override of the provider endpoint
  testMode: boolean     // see sendViaSms() — short-circuits every send to the mock adapter
}

const SETTINGS_KEYS = [
  'sms_provider',
  'sms_sender_id',
  'sms_default_country',
  'sms_api_key',
  'sms_api_secret',
  'sms_account_sid',
  'sms_api_url',
  'sms_test_mode',
] as const

async function loadSmsSettings(
  supabaseAdmin: ReturnType<typeof createClient>
): Promise<SmsSettings> {
  const { data, error } = await supabaseAdmin
    .from('settings')
    .select('key, value')
    .in('key', SETTINGS_KEYS as unknown as string[])

  if (error) {
    throw new Error('Failed to load SMS settings from database: ' + error.message)
  }

  const s: Record<string, string> = {}
  data?.forEach((row: any) => { s[row.key] = row.value })

  return {
    provider: (s['sms_provider'] || 'mock').trim().toLowerCase(),
    senderId: s['sms_sender_id'] || 'EllaStFest',
    defaultCountry: (s['sms_default_country'] || 'GB').trim().toUpperCase(),
    apiKey: s['sms_api_key'] || '',
    apiSecret: s['sms_api_secret'] || '',
    accountSid: s['sms_account_sid'] || '',
    apiUrl: s['sms_api_url'] || '',
    // Absent (e.g. a pre-migration environment) defaults to true — safe by
    // default, the same posture sms_provider takes defaulting to 'mock'. A
    // real send requires an admin to have explicitly turned this off in the
    // Settings page's SMS (The SMS Works) card.
    testMode: (s['sms_test_mode'] ?? 'true') !== 'false',
  }
}

/**
 * Normalise a user-entered phone number to E.164 (e.g. +447700900123).
 * Deliberately conservative: strips spacing/punctuation, maps a leading
 * national trunk '0' to the default country's dialling code, and accepts
 * numbers already in +/00 international form. Only GB is special-cased for the
 * trunk-'0' rule since that's the festival's audience; other countries must be
 * entered in full international form. Throws on anything it can't confidently
 * turn into E.164 — a bad number should fail loudly at queue time, not vanish.
 */
export function normalizePhone(raw: string, defaultCountry = 'GB'): string {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Phone number is empty.')
  }

  // Keep a leading +, drop every other non-digit.
  let n = raw.trim().replace(/[^\d+]/g, '')

  // 00 international prefix -> +
  if (n.startsWith('00')) n = '+' + n.slice(2)

  // Collapse every recognised form down to bare E.164 digits (no leading +),
  // then apply ONE length check to all of them. Previously the length check
  // only ran on the `+...` branch - `normalizePhone('44')` or
  // `normalizePhone('0')` returned '+44' with no digits at all, since the
  // GB trunk-0/44 branches skipped validation entirely.
  let digits: string
  if (n.startsWith('+')) {
    digits = n.slice(1)
  } else if (defaultCountry === 'GB' && n.startsWith('0')) {
    // National format. Only GB's trunk-0 rule is handled automatically.
    digits = '44' + n.slice(1)
  } else if (defaultCountry === 'GB' && n.startsWith('44')) {
    digits = n
  } else {
    throw new Error(
      `Phone number "${raw}" is not in international (+...) form and no rule ` +
      `exists to normalise it for country ${defaultCountry}.`
    )
  }

  if (digits.length < 8 || digits.length > 15) {
    throw new Error(`Phone number "${raw}" is not a valid E.164 length.`)
  }
  return '+' + digits
}

/**
 * Rough billed-segment count. GSM-7 fits 160 chars in one part (153 each when
 * concatenated); any char outside the GSM-7 set forces UCS-2 at 70/67. This is
 * an estimate for cost visibility in the queue, not a billing oracle.
 */
export function countSegments(text: string): number {
  const GSM7 = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\\[~\]|€]*$/
  const unicode = !GSM7.test(text)
  const len = text.length
  if (unicode) return len <= 70 ? 1 : Math.ceil(len / 67)
  return len <= 160 ? 1 : Math.ceil(len / 153)
}

// ---------------------------------------------------------------------------
// Adapters. Each takes the normalised recipient, body, and settings, performs
// the provider call, and returns the provider's message id (or null). They
// throw on any non-success so the caller records status='Error' with the
// message — same contract sendViaZoho has.
// ---------------------------------------------------------------------------
type SmsAdapter = (
  to: string,
  body: string,
  s: SmsSettings
) => Promise<{ providerMessageId: string | null }>

/**
 * No-op provider. Logs and reports success without contacting anyone. This is
 * the default until a real provider is configured, so the queue, drain, retry,
 * and viewer all work with zero setup and zero cost.
 */
const sendViaMock: SmsAdapter = async (to, body) => {
  // Log tag deliberately avoids the `[name:value]` shape — css/input.css's
  // Tailwind `@source` scans the whole repo, and that syntax is read as an
  // arbitrary CSS property, emitting a junk `.[sms\:mock] { sms: mock }` rule
  // into the built stylesheet (caught by css-build-check on PR #109).
  console.log(`[sms/mock] would send to ${to}: ${body.slice(0, 80)}${body.length > 80 ? '…' : ''}`)
  return { providerMessageId: `mock-${crypto.randomUUID()}` }
}

/**
 * The SMS Works (UK, pay-as-you-go). Auth is a customer JWT in the
 * Authorization header. https://api.thesmsworks.co.uk/v1/message/send
 */
const sendViaTheSmsWorks: SmsAdapter = async (to, body, s) => {
  if (!s.apiKey) throw new Error('The SMS Works selected but sms_api_key (JWT) is not set.')
  const url = s.apiUrl || 'https://api.thesmsworks.co.uk/v1/message/send'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': s.apiKey, 'Content-Type': 'application/json' },
    // Their API expects destination without the leading '+'.
    body: JSON.stringify({ sender: s.senderId, destination: to.replace(/^\+/, ''), content: body }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`The SMS Works send failed (${res.status}): ${text}`)
  let json: any = {}
  try { json = JSON.parse(text) } catch { /* non-JSON success body — leave id null */ }
  return { providerMessageId: json.messageid ?? json.messageId ?? null }
}

export interface DeliveryStatusResult {
  status: string | null
  failureReason: { code?: number; details?: string; permanent?: boolean } | null
}

/**
 * Checks a previously-sent message's ACTUAL delivery outcome via
 * GET /messages/{messageid} — distinct from, and only ever called after,
 * the send call to POST /message/send. Confirmed against The SMS Works'
 * official OpenAPI-generated SDK docs (not the marketing site, which
 * fabricated details on an earlier check): same raw-JWT Authorization
 * header as sending, response is `{status, failurereason?: {code, details,
 * permanent}, ...}`.
 *
 * `status` is returned VERBATIM and never validated against a hardcoded
 * list — SMS Works' spec does not enumerate this field (only one value,
 * EXPIRED, could be confirmed from a primary source), so this function
 * makes no assumption about the vocabulary. Any coloring/interpretation of
 * the string happens client-side, as a best-effort heuristic, not here.
 *
 * Deliberately SMS-Works-specific (unlike sendViaSms, this has no adapter
 * dispatch table) — mock/Twilio have no equivalent check implemented, and
 * this throws if `sms_provider` isn't 'thesmsworks' rather than silently
 * doing nothing, so checking an old message after switching providers fails
 * loudly instead of looking like a no-op success.
 */
export async function checkDeliveryStatus(
  supabaseAdmin: ReturnType<typeof createClient>,
  providerMessageId: string
): Promise<DeliveryStatusResult> {
  const settings = await loadSmsSettings(supabaseAdmin)
  if (settings.provider !== 'thesmsworks') {
    throw new Error(
      `Delivery status checking is only implemented for The SMS Works; the ` +
      `configured sms_provider is "${settings.provider}".`
    )
  }
  if (!settings.apiKey) {
    throw new Error('The SMS Works selected but sms_api_key (JWT) is not set.')
  }

  // sms_api_url, when set, overrides the SEND url verbatim (see
  // sendViaTheSmsWorks) — typically ".../v1/message/send". Derive the
  // status-check url from the same override by swapping that known suffix
  // for ".../v1/messages/{id}", so a test (or a future real override) that
  // points sms_api_url at an alternate host affects both calls consistently
  // without needing a second settings key purely for this.
  const url = settings.apiUrl && settings.apiUrl.endsWith('/message/send')
    ? settings.apiUrl.replace(/\/message\/send$/, `/messages/${providerMessageId}`)
    : `https://api.thesmsworks.co.uk/v1/messages/${providerMessageId}`

  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': settings.apiKey },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`The SMS Works status check failed (${res.status}): ${text}`)

  let json: any = {}
  try { json = JSON.parse(text) } catch {
    throw new Error(`The SMS Works status check returned a non-JSON body: ${text.slice(0, 200)}`)
  }

  return {
    status: json.status ?? null,
    failureReason: json.failurereason ?? null,
  }
}

/**
 * Twilio. Basic auth Account SID:Auth Token, form-encoded body.
 * https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json
 */
const sendViaTwilio: SmsAdapter = async (to, body, s) => {
  if (!s.accountSid || !s.apiSecret) {
    throw new Error('Twilio selected but sms_account_sid and/or sms_api_secret (auth token) is not set.')
  }
  const url = s.apiUrl || `https://api.twilio.com/2010-04-01/Accounts/${s.accountSid}/Messages.json`
  const form = new URLSearchParams({ To: to, From: s.senderId, Body: body })
  const auth = btoa(`${s.accountSid}:${s.apiSecret}`)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Twilio send failed (${res.status}): ${text}`)
  let json: any = {}
  try { json = JSON.parse(text) } catch { /* leave id null */ }
  return { providerMessageId: json.sid ?? null }
}

const ADAPTERS: Record<string, SmsAdapter> = {
  mock: sendViaMock,
  thesmsworks: sendViaTheSmsWorks,
  twilio: sendViaTwilio,
}

/**
 * Send one SMS via whichever provider `settings.sms_provider` names. Returns a
 * result the caller writes to sms_queue (provider_message_id + segments);
 * throws on failure so the caller records status='Error' with e.message.
 */
export async function sendViaSms(
  supabaseAdmin: ReturnType<typeof createClient>,
  params: { recipient: string; body: string }
): Promise<SmsSendResult> {
  const { recipient, body } = params
  if (!recipient || !body) {
    throw new Error('Missing required fields: recipient, body')
  }

  const settings = await loadSmsSettings(supabaseAdmin)

  // Validate the CONFIGURED provider name even in test mode, so a typo in
  // sms_provider is caught now rather than only surfacing once test mode is
  // switched off and a real send is attempted for the first time.
  if (!ADAPTERS[settings.provider]) {
    throw new Error(
      `Unknown sms_provider "${settings.provider}". Known: ${Object.keys(ADAPTERS).join(', ')}.`
    )
  }

  // Test Mode is a separate, more visible master switch from sms_provider —
  // see the 20260728090000 migration's docstring. When on, every send is
  // routed through the mock adapter regardless of which real provider is
  // configured, so pointing sms_provider at 'thesmsworks' and filling in
  // live credentials cannot by itself cause a real send — an admin has to
  // deliberately turn this off first.
  const effectiveProvider = settings.testMode ? 'mock' : settings.provider
  const adapter = ADAPTERS[effectiveProvider]

  // recipient is expected already-normalised by the caller (queue insert path),
  // but normalise defensively so a hand-inserted row can't send to a bad number.
  const to = normalizePhone(recipient, settings.defaultCountry)
  const { providerMessageId } = await adapter(to, body, settings)

  return {
    success: true,
    providerMessageId,
    segments: countSegments(body),
    provider: effectiveProvider,
  }
}
