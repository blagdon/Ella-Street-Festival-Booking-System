// Organisation/event slug validation for Edge Functions.
//
// Mirrored (not imported — different runtimes) in js/utils.js for the
// browser side. Keep RESERVED_SLUGS and the format rule in sync by hand;
// there's no shared module system between Deno and browser ESM here.
//
// Covers every real top-level page basename plus generic infrastructure
// words and the Phase 1 sentinel ids (org_default/event_default), which
// must stay reserved so a real organisation can never claim them.
// Stored hyphenated, matching SLUG_FORMAT below — a cleaned candidate can
// never contain an underscore, so an underscored entry here would be
// unreachable dead weight (it would always fail the format check first,
// while the hyphenated form of the same name would slip through unreserved).
export const RESERVED_SLUGS = new Set([
  // Real top-level pages (basename, no .html; underscores -> hyphens)
  'food-stall-booking', 'general-booking', 'add-misc', 'admin', 'audit-log',
  'booking-forms', 'cancel-booking', 'comms-admin', 'hcc-dashboard', 'index',
  'kanban-m', 'location-admin', 'login', 'manage-users', 'message-queue',
  'more', 'pay', 'payment-cancelled', 'payment-success', 'payments',
  'settings', 'stats', 'steward', 'steward-login', 'summary',
  'update-details', 'visitor-map', 'event', 'provisioning',
  // Sentinel/system ids
  'org-default', 'event-default', 'null', 'undefined',
  // Generic infrastructure words worth keeping off-limits
  'api', 'app', 'www', 'static', 'assets', 'public', 'cdn', 'help',
  'support', 'docs', 'blog', 'about', 'contact', 'terms', 'privacy',
  'dashboard', 'root', 'system',
])

const SLUG_FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/
const SLUG_MAX_LEN = 63

/**
 * Normalises and validates an organisation or event slug. Throws with a
 * message safe to return directly in an API error response; returns the
 * cleaned slug on success. Deliberately rejects invalid input rather than
 * silently stripping characters (the previous behaviour for org_slug) —
 * two different intended slugs silently stripping down to the same string
 * is exactly the kind of surprise this exists to prevent.
 */
export function validateSlug(value: unknown, label = 'Slug'): string {
  if (!value || typeof value !== 'string') throw new Error(`${label} is required.`)
  const cleaned = value.trim().toLowerCase()
  if (cleaned.length === 0) throw new Error(`${label} is required.`)
  if (cleaned.length > SLUG_MAX_LEN) throw new Error(`${label} must be ${SLUG_MAX_LEN} characters or fewer.`)
  if (!SLUG_FORMAT.test(cleaned)) {
    throw new Error(`${label} can only contain lowercase letters, numbers, and single hyphens (not at the start, end, or doubled).`)
  }
  if (RESERVED_SLUGS.has(cleaned)) {
    throw new Error(`'${cleaned}' is a reserved word and can't be used as ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label.toLowerCase()}.`)
  }
  return cleaned
}
