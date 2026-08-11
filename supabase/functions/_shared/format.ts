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

// Mirrors js/utils.js's formatCurrency() exactly (V1.1 Sprint 2, Issue 8).
// GBP only, matching what create-checkout-session/get-payment-link actually
// hardcode as the Stripe `currency` - presentation consistency, not
// multi-currency support. Shared by create-checkout-session and
// stripe-webhook so their confirmation-email cost strings agree with each
// other and with the frontend's formatting (thousands separator + exactly
// two decimal places), rather than each independently calling toFixed(2).
export function formatCurrency(amount: number): string {
  return `£${amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
