/**
 * Cloudflare Turnstile CAPTCHA verification, shared across every public
 * unauthenticated Edge Function that needs it (submit-booking, cancel-
 * booking, and now get-payment-link once it starts creating real Stripe
 * sessions rather than just looking one up). Previously duplicated
 * separately in submit-booking and cancel-booking with slightly different
 * body encodings and error messages - unified here now that a third
 * consumer exists.
 */
import { PublicError } from './errors.ts'

/**
 * Verifies a Turnstile response token against Cloudflare's siteverify API.
 * Throws PublicError with a generic, safe-to-show message on failure -
 * Cloudflare's own error codes are logged server-side (console.warn) for
 * diagnosability, never returned to the caller.
 */
export async function verifyTurnstile(token: unknown): Promise<void> {
  if (!token || typeof token !== 'string') {
    throw new PublicError('Please complete the CAPTCHA verification.')
  }

  const secret = Deno.env.get('TURNSTILE_SECRET_KEY')
  if (!secret) {
    throw new Error('TURNSTILE_SECRET_KEY is not configured on the server.')
  }

  const verifyResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, response: token }),
  })
  const verifyData = await verifyResponse.json()

  if (!verifyData.success) {
    const codes = verifyData['error-codes'] ? verifyData['error-codes'].join(', ') : 'unknown'
    console.warn('Turnstile verification failed:', codes)
    throw new PublicError('CAPTCHA verification failed. Please try again.')
  }
}
