// Mirrors js/utils.js's escapeHtml() exactly. Single source of truth for
// Edge Functions that build HTML email bodies (submit-booking, cancel-booking,
// stripe-webhook, create-checkout-session) - a pure string function, not a
// network call, so importing it here doesn't run into the sibling-HTTP-call
// pattern the pre-commit hook guards against.
export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}
