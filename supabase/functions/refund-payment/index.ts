import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { resolveStripeMode, getStripeClient, loadStripeSettings } from '../_shared/stripe.ts'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'
import { captureAndFlush } from '../_shared/sentry.ts'
import { resolveCallerAdminScope } from '../_shared/tenant-auth.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/**
 * Issues a real Stripe refund for a booking, then records it via
 * rpc_record_refund.
 *
 * ONLY for payment_method = 'stripe'. A bank transfer has no API to call —
 * the money moves when a human moves it — so those stay on the record-only
 * path in the Payments UI. That asymmetry is inherent to the payment methods,
 * not a gap in this function.
 *
 * ORDER MATTERS AND IS DELIBERATE: Stripe first, database second.
 *  - Stripe succeeds, DB write fails  -> money HAS moved and the app doesn't
 *    know. Recoverable: the charge.refunded webhook records it moments later,
 *    and failing that an admin can record it manually with the refund id from
 *    the error message, which is why that id is surfaced in the error.
 *  - DB first, Stripe fails           -> the app claims a refund that never
 *    happened, and nothing external will ever correct it.
 * The first failure mode is self-healing; the second is silent and permanent.
 *
 * Admin JWT only, with no service-role bypass: issuing a refund moves real
 * money and must always be a deliberate human action.
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const supabaseAdmin = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    if (!supabaseUrl || !supabaseAnonKey) {
      return new Response(
        JSON.stringify({ error: 'Server misconfiguration: Supabase credentials are missing' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized: ' + authError?.message }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // organisation_members-based - see queue-bulk-email's identical comment.
    // user_roles.role is NOT org-scoped (every org's admin gets a row there),
    // so checking it alone would let any organisation's admin refund any
    // OTHER organisation's payments.
    const callerScope = await resolveCallerAdminScope(supabaseAdmin, user.id)
    if (!callerScope.isPlatformAdmin && callerScope.orgIds.length === 0) {
      return new Response(JSON.stringify({ error: 'Forbidden: Admin role required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { booking_id, amount, notes } = await req.json()

    if (!booking_id || typeof booking_id !== 'string') {
      return new Response(JSON.stringify({ error: 'booking_id is required.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // org_id is selected so it can be derived from the booking itself below
    // (never from client input) for both the Stripe credential lookup and
    // the rpc_record_refund authorization check. The org filter is applied
    // to the query itself (same pattern as retry-queued-sms) rather than
    // checked after the fact, so a cross-tenant booking id reads as a plain
    // 404 - it never even reveals that the booking exists.
    let bookingQuery = supabaseAdmin
      .from('bookings')
      .select('id, org_id, instance_prefix, stall_cost, stripe_payment_intent_id')
      .eq('id', booking_id)
    if (!callerScope.isPlatformAdmin) {
      bookingQuery = bookingQuery.in('org_id', callerScope.orgIds)
    }
    const { data: booking, error: bookingErr } = await bookingQuery.single()

    if (bookingErr || !booking) {
      return new Response(JSON.stringify({ error: 'Booking not found.' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { data: payment, error: paymentErr } = await supabaseAdmin
      .from('payments')
      .select('paid, payment_method, refund_amount')
      .eq('booking_id', booking_id)
      .maybeSingle()

    if (paymentErr) throw new Error('Failed to load payment: ' + paymentErr.message)

    if (!payment || payment.paid !== true) {
      return new Response(JSON.stringify({ error: 'This booking has no recorded payment to refund.' }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Checked here as well as in the RPC: better to refuse before calling
    // Stripe than to move money and then fail to record it.
    if (payment.refund_amount != null) {
      return new Response(JSON.stringify({ error: 'This booking has already been refunded.' }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (payment.payment_method !== 'stripe') {
      return new Response(JSON.stringify({
        error: `Only Stripe payments can be refunded automatically (this one is "${payment.payment_method || 'unknown'}"). Refund it manually and record it in the Payments page.`
      }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!booking.stripe_payment_intent_id) {
      return new Response(JSON.stringify({
        error: 'This booking has no Stripe payment intent recorded, so it cannot be refunded automatically.'
      }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Default to a full refund of the booking cost; an explicit amount allows
    // a partial one.
    const fullAmount = Number(booking.stall_cost)
    const refundAmount = amount != null ? Number(amount) : fullAmount

    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      return new Response(JSON.stringify({ error: 'Refund amount must be greater than zero.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (Number.isFinite(fullAmount) && refundAmount > fullAmount) {
      return new Response(JSON.stringify({ error: `Refund amount ${refundAmount} exceeds the booking cost ${fullAmount}.` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const settings = await loadStripeSettings(supabaseAdmin, booking.org_id)
    const mode = resolveStripeMode(booking.instance_prefix, settings.testModeSetting)
    const stripe = getStripeClient(mode, settings)

    // Stripe works in the smallest currency unit.
    const refund = await stripe.refunds.create({
      payment_intent: booking.stripe_payment_intent_id,
      amount: Math.round(refundAmount * 100),
      metadata: { booking_id: booking.id }
    })

    // Invoked as the caller (not the bare service-role client) so
    // rpc_record_refund's own auth.uid()-based org check - is_authorised_for_org
    // against the booking's actual org_id - actually executes, instead of
    // silently taking the unauthenticated/system branch. Same pattern as
    // invite-organisation-member's callerClient.
    const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    })

    const { error: recordErr } = await callerClient.rpc('rpc_record_refund', {
      p_booking_id: booking.id,
      p_refund_amount: refundAmount,
      p_refund_reference: refund.id,
      p_notes: notes || null,
      p_refunded_by: 'Stripe (automatic)'
    })

    if (recordErr) {
      // The money HAS moved at this point. Surface the refund id prominently
      // so it can be reconciled by hand if the webhook doesn't arrive.
      throw new Error(
        `Stripe refund ${refund.id} succeeded, but recording it failed: ${recordErr.message}. ` +
        `The refund IS issued — record it manually with reference ${refund.id} if it doesn't appear shortly.`
      )
    }

    return new Response(JSON.stringify({
      success: true,
      refund_id: refund.id,
      refund_amount: refundAmount,
      mode
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error: any) {
    console.error('refund-payment error:', error.message)
    await captureAndFlush(error, 'refund-payment')
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
