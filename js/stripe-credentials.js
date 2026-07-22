/**
 * stripe-credentials.js
 *
 * The rule for deciding WHICH Stripe credential rows a save writes, kept in
 * its own module with no imports so it can be unit-tested directly. Every
 * other module under js/ pulls in supabase.js/config.js, which touch browser
 * globals at import time and therefore cannot be loaded from a Node test —
 * see tests/stripe-credentials-save.test.mjs.
 *
 * WHY THIS EXISTS: the save handler used to write all four fields
 * unconditionally, taking each input's value verbatim. An empty input is
 * indistinguishable from "no value configured", so any save performed while
 * a field happened to be blank wrote an empty string over whatever was
 * stored. Two ways that fired:
 *
 *   1. The initial load of the credentials failed (transient network, expired
 *      session). The catch showed a toast and carried on, leaving all four
 *      inputs empty; the next save wiped all four rows.
 *   2. The documented, intended workflow — "fill in the Test pair now, add
 *      Live later" — wiped the Live keys every time, because they were blank.
 *
 * Case 1 is now blocked by the caller refusing to save at all when the load
 * failed. Case 2 is fixed here: a blank field means "leave this row alone",
 * so a save only ever writes the credentials actually present.
 *
 * The tradeoff is that a credential can no longer be CLEARED through the
 * settings UI, only replaced. That is deliberate: clearing one is a rare
 * deliberate act with a direct route (edit the settings row), whereas wiping
 * one by accident was a single click away.
 */

/** The four settings-table rows the Stripe credentials card owns. */
export const STRIPE_CREDENTIAL_KEYS = [
    'stripe_secret_key_test',
    'stripe_secret_key_live',
    'stripe_webhook_secret_test',
    'stripe_webhook_secret_live'
];

/**
 * Builds the rows to upsert into `settings` for a Stripe credentials save.
 *
 * @param {Record<string, string>} values  Raw field values keyed by settings
 *   key. A key that is missing, blank, or whitespace-only is omitted from the
 *   result rather than written as an empty string.
 * @param {{ updatedAt: string, updatedBy: string }} meta  Audit columns
 *   applied to every row written.
 * @returns {Array<{key: string, value: string, updated_at: string, updated_by: string}>}
 *   Rows to upsert — possibly empty, which the caller should treat as
 *   "nothing to save" rather than issuing a no-op write.
 */
export function buildStripeCredentialUpdates(values, meta) {
    const source = values || {};
    return STRIPE_CREDENTIAL_KEYS
        .map(key => ({
            key,
            value: String(source[key] ?? '').trim(),
            updated_at: meta.updatedAt,
            updated_by: meta.updatedBy
        }))
        .filter(row => row.value !== '');
}
