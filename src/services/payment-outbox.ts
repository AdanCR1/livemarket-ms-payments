import { createSupabaseAdmin } from '../utils/supabase';
import { paymentEvent } from '../utils/payment-event';
import { callMS4 } from './ms4-client';
import type { Env } from '../types';

export async function processPaymentOutbox(env: Env) {
  const db = createSupabaseAdmin(env);
  const { data: events, error } = await db.rpc('ms6_claim_payment_events_v2', { p_limit: 5 });
  if (error || !Array.isArray(events)) {
    console.warn({ component: 'MS6_OUTBOX', code: 'CLAIM_UNAVAILABLE',
      databaseCode: error?.code ?? 'INVALID_CLAIM_RESPONSE' });
    return { success: false, code: 'OUTBOX_CLAIM_UNAVAILABLE' };
  }
  let sent = 0, failed = 0, ack_failed = 0;
  for (const event of events) {
    if (typeof event.claim_token !== 'string') {
      ack_failed++;
      continue;
    }
    let delivered = false;
    let reason = 'OUTBOX_DESTINATION_UNSUPPORTED';
    try {
      if (event.destination === 'MS4' && event.event_type === 'PAYMENT_SUCCEEDED') {
        const payload = paymentEvent(event.payload);
        if (!payload || payload.payment_id !== event.aggregate_id) throw new Error('OUTBOX_INVALID_PAYMENT_EVENT');
        const { data: escrow, error: escrowError } = await db.from('escrow_settlements')
          .select('id').eq('payment_id', event.aggregate_id).maybeSingle();
        if (escrowError || !escrow) throw new Error('ESCROW_PENDING_RECONCILIATION');
        await callMS4(env, '/api/internal/payments/events', 'POST', payload);
        delivered = true;
      }
    } catch (error) {
      reason = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'OUTBOX_DELIVERY_FAILED';
    }
    const ack = await db.rpc('ms6_ack_payment_event_v2', {
      p_event_id: event.id, p_claim_token: event.claim_token, p_success: delivered, p_error: delivered ? '' : reason,
    });
    if (ack.error || ack.data !== true) {
      ack_failed++;
      console.warn({ component: 'MS6_OUTBOX', code: 'ACK_FAILED', eventId: event.id,
        databaseCode: ack.error?.code ?? 'LEASE_NOT_OWNED' });
    } else if (delivered) sent++;
    else failed++;
  }
  return { success: ack_failed === 0 && failed === 0, claimed: events.length, sent, failed, ack_failed };
}
