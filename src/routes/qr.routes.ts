import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { auth } from '../middleware/auth';
import { createSupabaseAdmin, sha256Hex, signHmacSha256 } from '../utils/supabase';
import type { AppContext } from '../types';

const qrRoutes = new Hono<AppContext>();

// ─── POST /generate (Generar QR para Pedido o Suscripción) ────────────────────
qrRoutes.post(
  '/generate',
  auth,
  zValidator(
    'json',
    z.object({
      purpose: z.enum(['ORDER_PAYMENT', 'SUBSCRIPTION_UPGRADE']),
      reference_id: z.string().uuid(),
      target_store_id: z.string().uuid().optional(),
      requested_plan: z.enum(['PRO', 'ENTERPRISE']).optional(),
      amount: z.number().positive(),
      idempotency_key: z.string().min(8).max(200),
      validity_type: z.enum(['1_DAY', '7_DAYS', 'INDEFINITE']).optional().default('INDEFINITE'),
    })
  ),
  async (c) => {
    const body = c.req.valid('json');
    const supabase = createSupabaseAdmin(c.env);

    let expirationMs: number;
    switch (body.validity_type) {
      case '1_DAY':
        expirationMs = 24 * 60 * 60 * 1000;
        break;
      case '7_DAYS':
        expirationMs = 7 * 24 * 60 * 60 * 1000;
        break;
      case 'INDEFINITE':
      default:
        expirationMs = 10 * 365 * 24 * 60 * 60 * 1000;
        break;
    }
    const expiresAt = new Date(Date.now() + expirationMs).toISOString();

    let { data: payment, error: pError } = await supabase
      .from('payments')
      .insert({
        purpose: body.purpose,
        reference_id: body.reference_id,
        target_store_id: body.target_store_id || null,
        requested_plan: body.requested_plan || null,
        amount: body.amount,
        currency: 'BOB',
        idempotency_key: body.idempotency_key,
      })
      .select('*')
      .single();

    if (pError) {
      const { data: existing } = await supabase
        .from('payments')
        .select('*')
        .eq('idempotency_key', body.idempotency_key)
        .single();

      if (!existing) {
        return c.json({ success: false, error: pError.message }, 400);
      }

      const sameRequest =
        existing.purpose === body.purpose &&
        existing.reference_id === body.reference_id &&
        existing.target_store_id === (body.target_store_id || null) &&
        existing.requested_plan === (body.requested_plan || null) &&
        Number(existing.amount) === body.amount;

      if (!sameRequest) {
        return c.json(
          { success: false, error: 'La clave de idempotencia ya fue utilizada con otros datos' },
          409
        );
      }

      payment = existing;
    }

    if (payment.status === 'PAID') {
      return c.json({ success: false, error: 'Esta obligación ya está pagada' }, 400);
    }

    const rawQrToken = `MC-QR-${crypto.randomUUID()}-${Date.now()}`;
    const qrTokenHash = await sha256Hex(rawQrToken);
    const signature = await signHmacSha256(
      `${payment.id}:${payment.amount}:${rawQrToken}`,
      c.env.PAYMENT_QR_SECRET
    );

    await supabase
      .from('payment_qrs')
      .update({ status: 'CANCELLED' })
      .eq('payment_id', payment.id)
      .eq('status', 'PENDING');

    const { error: qrError } = await supabase.from('payment_qrs').insert({
      payment_id: payment.id,
      qr_token_hash: qrTokenHash,
      signature,
      expires_at: expiresAt,
      status: 'PENDING',
    });

    if (qrError) {
      return c.json({ success: false, error: qrError.message }, 500);
    }

    return c.json(
      {
        success: true,
        data: {
          payment_id: payment.id,
          qr_token: rawQrToken,
          amount: payment.amount,
          currency: payment.currency,
          purpose: payment.purpose,
          expires_at: expiresAt,
        },
      },
      201
    );
  }
);

// ─── GET /scan/:token (Lectura de QR desde la App Móvil) ──────────────────────
qrRoutes.get('/scan/:token', auth, async (c) => {
  const rawQrToken = c.req.param('token');
  const qrTokenHash = await sha256Hex(rawQrToken);
  const supabase = createSupabaseAdmin(c.env);

  const { data: qr, error } = await supabase
    .from('payment_qrs')
    .select(`
      id,
      status,
      expires_at,
      payments (
        id,
        purpose,
        reference_id,
        amount,
        currency,
        status
      )
    `)
    .eq('qr_token_hash', qrTokenHash)
    .single();

  if (error || !qr) {
    return c.json({ success: false, error: 'QR no válido o no encontrado' }, 404);
  }

  const payment = qr.payments as any;
  const isExpired = new Date(qr.expires_at).getTime() <= Date.now();

  return c.json({
    success: true,
    data: {
      qr_id: qr.id,
      status: isExpired ? 'EXPIRED' : qr.status,
      payment_id: payment.id,
      purpose: payment.purpose,
      reference_id: payment.reference_id,
      amount: payment.amount,
      currency: payment.currency,
      expires_at: qr.expires_at,
    },
  });
});

// ─── POST /pay (Confirmar Pago con PIN desde la App Móvil) ────────────────────
qrRoutes.post(
  '/pay',
  auth,
  zValidator(
    'json',
    z.object({
      qr_token: z.string(),
      pin: z.string().min(4).max(6),
    })
  ),
  async (c) => {
    const actor = c.get('actor');
    const { qr_token, pin } = c.req.valid('json');
    const supabase = createSupabaseAdmin(c.env);

    const { data: acc } = await supabase
      .from('bank_accounts')
      .select('id')
      .eq('owner_user_id', actor.id)
      .single();

    if (!acc) {
      return c.json({ success: false, error: 'No tienes una cuenta bancaria asignada' }, 404);
    }

    const qrTokenHash = await sha256Hex(qr_token);

    const { data, error } = await supabase.rpc('execute_qr_payment', {
      p_qr_token_hash: qrTokenHash,
      p_account_id: acc.id,
      p_pin: pin,
    });

    if (error) {
      return c.json({ success: false, error: error.message }, 400);
    }

    if (!data.success) {
      return c.json({ success: false, code: data.code }, 400);
    }

    // Si es pago de orden, crear custodia y notificar a MS4
    if (data.purpose === 'ORDER_PAYMENT') {
      const { data: paymentRecord } = await supabase
        .from('payments')
        .select('target_store_id')
        .eq('id', data.payment_id)
        .single();

      const { error: escrowError } = await supabase
        .from('escrow_settlements')
        .insert({
          payment_id: data.payment_id,
          order_id: data.reference_id,
          store_id: paymentRecord?.target_store_id,
          customer_id: actor.id,
          amount: data.amount,
          currency: data.currency,
          status: 'HELD',
        });

      if (escrowError) {
        console.error('[Escrow Insert Error]:', escrowError.message);
      }

      c.executionCtx.waitUntil(
        fetch(`${c.env.MS4_URL.replace(/\/$/, '')}/api/internal/payments/events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': c.env.PAYMENTS_INTERNAL_KEY,
          },
          body: JSON.stringify({
            event_id: crypto.randomUUID(),
            payment_id: data.payment_id,
            order_id: data.reference_id,
            status: 'PAID',
            amount: Number(data.amount).toFixed(2),
            currency: data.currency,
          }),
        }).catch((err) => console.error('[Webhook MS4 Error]:', err.message))
      );
    }

    return c.json({ success: true, data });
  }
);

export default qrRoutes;