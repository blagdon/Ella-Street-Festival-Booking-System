import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { resolveStripeMode, getStripeClient, loadStripeSettings } from '../_shared/stripe.ts'
import { ALLOWED_ORIGIN } from '../_shared/cors.ts'

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
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

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

    const { data: roleData, error: roleError } = await supabaseAdmin
      .from('user_roles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (roleError || !roleData || roleData.role !== 'admin') {
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

    const { data: booking, error: bookingErr } = await supabaseAdmin
      .from('bookings')
      .select('id, instance_prefix, stall_cost, stripe_payment_intent_id')
      .eq('id', booking_id)
      .single()

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

    const settings = await loadStripeSettings(supabaseAdmin)
    const mode = resolveStripeMode(booking.instance_prefix, settings.testModeSetting)
    const stripe = getStripeClient(mode, settings)

    // Stripe works in the smallest currency unit.
    const refund = await stripe.refunds.create({
      payment_intent: booking.stripe_payment_intent_id,
      amount: Math.round(refundAmount * 100),
      metadata: { booking_id: booking.id }
    })

    const { error: recordErr } = await supabaseAdmin.rpc('rpc_record_refund', {
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
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
