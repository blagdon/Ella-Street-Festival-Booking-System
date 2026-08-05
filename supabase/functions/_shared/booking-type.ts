// Booking-type classification, shared across every Edge Function that needs
// to tell a food stall's instance_prefix apart from a general/non-food one.
//
// Mirrored (not imported — different runtimes) in js/config.js's
// isFoodPrefix() for the browser side. Keep both in sync by hand; there's no
// shared module system between Deno and browser ESM here (same reasoning as
// _shared/slugs.ts / js/utils.js's validateSlug()).

/**
 * Whether an instance prefix (e.g. "RAM26-FOOD-", "RAM26-NONFOOD-") denotes
 * a food stall. Deliberately guards against "NONFOOD" containing "FOOD" as a
 * substring - a plain `.includes('FOOD')` miscategorises every General/
 * Non-Food booking as food. This is exactly what submit-booking's
 * booking_type computation did before the RC operational certification's
 * Finding 5 - js/config.js's getStallCost() already had the correct guarded
 * check in one place, but it was never swept to this one.
 */
export function isFoodPrefix(prefix: string | null | undefined): boolean {
  if (!prefix) return false
  const p = prefix.toUpperCase()
  return p.includes('FOOD') && !p.includes('NONFOOD')
}
