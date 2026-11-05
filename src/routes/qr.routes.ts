import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { auth } from '../middleware/auth';
import { createSupabaseAdmin, sha256Hex, signHmacSha256 } from '../utils/supabase';
import type { AppContext } from '../types';

const routes = new Hono<AppContext>();
const money = (v: unknown) => Number(v).toFixed(2);
const isSame = (a: string, b: string) => a.length === b.length &&
  [...a].reduce((v, ch, i) => v | (ch.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;

/** MS4 es la única fuente del importe y tienda de pedidos. */
async function trustedOrderQuote(c: any, orderId: string) {
  if (!c.env.MS4_URL || !c.env.PAYMENTS_INTERNAL_KEY) throw new Error('MS4 no configurado');
  const res = await fetch(`${c.env.MS4_URL.replace(/\/+$/, '')}/api/internal/orders/${orderId}/payment-quote`, {
    headers: { 'X-Internal-Key': c.env.PAYMENTS_INTERNAL_KEY }, signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`MS4 rechazó la cotización (${res.status})`);
  const json: any = await res.json();
  if (!json.success || !json.data) throw new Error('Cotización inválida');
  return json.data;
}


routes.post(
  '/generate',
  auth,
  zValidator(
    'json',
    z.object({
      purpose: z.enum(['ORDER_PAYMENT', 'SUBSCRIPTION_UPGRADE']),
      reference_id: z.string().uuid(),
      target_store_id: z.string().uuid().optional(),
      requested_plan: z.enum(['PRO', 'ENTERPRISE']).optional(),
      amount: z.number().positive().optional(),
      idempotency_key: z.string().min(8).max(200),
      validity_type: z.enum(['1_DAY', '7_DAYS', 'INDEFINITE']).optional(),
    }).strict()
  ),
  async (c) => {
    const body = c.req.valid('json');
    const actor = c.get('actor');

    let amount: string;
    let targetStore: string | null = null;
    let orderCustomerId: string | null = null;
    let ttlMinutes = 10;

    if (body.purpose === 'ORDER_PAYMENT') {
      if (!['B2C', 'B2B'].includes(actor.role)) {
        return c.json({
          success: false,
          error: 'Se requiere cuenta compradora'
        }, 403);
      }

      let order: any;

      try {
        order = await trustedOrderQuote(c, body.reference_id);
      } catch (e) {
        return c.json({
          success: false,
          error: e instanceof Error ? e.message : 'MS4 no disponible'
        }, 503);
      }

      if (order.customer_id !== actor.id) {
        return c.json({
          success: false,
          error: 'Pedido no disponible'
        }, 404);
      }

      if (!order.payable) {
        return c.json({
          success: false,
          error: 'Pedido no admite pagos'
        }, 409);
      }

      if (
        order.currency !== 'BOB' ||
        !Number.isFinite(Number(order.amount)) ||
        Number(order.amount) <= 0
      ) {
        return c.json({
          success: false,
          error: 'Importe de pedido inválido'
        }, 409);
      }

      if (
        body.target_store_id &&
        body.target_store_id !== order.store_id
      ) {
        return c.json({
          success: false,
          error: 'Tienda inválida'
        }, 409);
      }

      if (
        body.amount !== undefined &&
        money(body.amount) !== money(order.amount)
      ) {
        return c.json({
          success: false,
          error: 'Importe no coincide con MS4'
        }, 409);
      }

      amount = money(order.amount);
      targetStore = order.store_id;
      orderCustomerId = order.customer_id;

      ttlMinutes = Math.max(
        0,
        Math.min(
          10,
          Math.floor(
            (
              new Date(order.reservation_expires_at).getTime() -
              Date.now()
            ) / 60000
          )
        )
      );

      if (ttlMinutes < 1) {
        return c.json({
          success: false,
          error: 'Reserva muy próxima a expirar'
        }, 409);
      }

      // La generación es independiente de la autorización de cobro.
      // POST /pay mantiene ORDER_ESCROW_ATOMIC_VERIFIED.

    } else {
      if (
        actor.role !== 'B2B' ||
        actor.storeId !== body.reference_id
      ) {
        return c.json({
          success: false,
          error: 'Tienda no autorizada'
        }, 403);
      }

      if (
        body.requested_plan !== 'PRO' ||
        body.target_store_id !== undefined ||
        body.amount !== undefined
      ) {
        return c.json({
          success: false,
          error: 'Solo PRO admite QR sin importe del cliente'
        }, 400);
      }

      if (
        Number(c.env.SUBSCRIPTION_PRO_BOB) !== 59 ||
        !z.string().uuid().safeParse(
          c.env.PLATFORM_BANK_ACCOUNT_ID
        ).success ||
        c.env.PRO_TREASURY_SQL_VERIFIED !== 'true'
      ) {
        return c.json({
          success: false,
          error: 'Cobro PRO pendiente de validación financiera'
        }, 503);
      }

      amount = '59.00';
      targetStore = null;
      ttlMinutes = 10;
    }

    const db = createSupabaseAdmin(c.env);

    const record = {
      purpose: body.purpose,
      reference_id: body.reference_id,
      target_store_id: targetStore,
      order_customer_id: orderCustomerId,
      requested_plan:
        body.purpose === 'SUBSCRIPTION_UPGRADE' ? 'PRO' : null,
      amount,
      currency: 'BOB',
      idempotency_key: body.idempotency_key,
    };

    let {
      data: payment,
      error: paymentError
    } = await db
      .from('payments')
      .insert(record)
      .select('*')
      .single();

    if (paymentError) {
      const { data: existing, error: lookupError } = await db
        .from('payments')
        .select('*')
        .eq('idempotency_key', body.idempotency_key)
        .maybeSingle();

      if (lookupError || !existing) {
        return c.json({
          success: false,
          error: 'No se pudo crear obligación de pago'
        }, 409);
      }

      const equal =
        existing.purpose === record.purpose &&
        existing.reference_id === record.reference_id &&
        existing.target_store_id === record.target_store_id &&
        existing.requested_plan === record.requested_plan &&
        existing.order_customer_id === record.order_customer_id &&
        money(existing.amount) === record.amount;

      if (!equal) {
        return c.json({
          success: false,
          error: 'Clave idempotente reutilizada con otros datos'
        }, 409);
      }

      payment = existing;
    }

    if (!payment || payment.status !== 'PENDING') {
      return c.json({
        success: false,
        error: 'Pago ya procesado o cancelado'
      }, 409);
    }

    const qrToken =
      `MC-QR-${crypto.randomUUID()}-${Date.now()}`;

    const qrTokenHash = await sha256Hex(qrToken);

    const signature = await signHmacSha256(
      `${payment.id}:${payment.amount}:${qrToken}`,
      c.env.PAYMENT_QR_SECRET
    );

    const expiresAt = new Date(
      Date.now() + ttlMinutes * 60000
    ).toISOString();

    const { error: cancelError } = await db
      .from('payment_qrs')
      .update({ status: 'CANCELLED' })
      .eq('payment_id', payment.id)
      .eq('status', 'PENDING');

    if (cancelError) {
      return c.json({
        success: false,
        error: 'No se pudo renovar QR'
      }, 500);
    }

    const { error: qrError } = await db
      .from('payment_qrs')
      .insert({
        payment_id: payment.id,
        qr_token_hash: qrTokenHash,
        signature,
        expires_at: expiresAt,
        status: 'PENDING'
      });

    if (qrError) {
      return c.json({
        success: false,
        error: 'No se pudo registrar QR'
      }, 500);
    }

    return c.json({
      success: true,
      data: {
        payment_id: payment.id,
        qr_token: qrToken,
        amount: payment.amount,
        currency: 'BOB',
        purpose: payment.purpose,
        expires_at: expiresAt
      }
    }, 201);
  }
);


routes.get('/scan/:token', auth, async c => {
  const token = c.req.param('token');
  const db = createSupabaseAdmin(c.env);
  const { data, error } = await db.from('payment_qrs').select('id,status,expires_at,payments(id,purpose,reference_id,amount,currency,status)')
    .eq('qr_token_hash', await sha256Hex(token)).maybeSingle();
  if (error || !data) return c.json({ success: false, error: 'QR no válido' }, 404);
  const payment = data.payments as any;
  return c.json({
    success: true, data: {
      qr_id: data.id, status: Date.parse(data.expires_at) <= Date.now() ? 'EXPIRED' : data.status,
      payment_id: payment.id, purpose: payment.purpose, reference_id: payment.reference_id,
      amount: payment.amount, currency: payment.currency, expires_at: data.expires_at
    }
  });
});

routes.post('/pay', auth, zValidator('json', z.object({ qr_token: z.string().min(20), pin: z.string().regex(/^\d{4,6}$/) })), async c => {
  const actor = c.get('actor'); const { qr_token, pin } = c.req.valid('json');
  const db = createSupabaseAdmin(c.env);
  const { data: acc } = await db.from('bank_accounts').select('id').eq('owner_user_id', actor.id).maybeSingle();
  if (!acc) return c.json({ success: false, error: 'No tienes cuenta bancaria asignada' }, 404);
  if (acc.id.toLowerCase() === c.env.PLATFORM_BANK_ACCOUNT_ID?.trim().toLowerCase())
    return c.json({ success: false, error: 'La cuenta de tesorería no puede pagar QR' }, 403);
  const hash = await sha256Hex(qr_token);
  const { data: qr } = await db.from('payment_qrs').select('signature,payment_id,payments(id,amount,purpose,reference_id,target_store_id,status)')
    .eq('qr_token_hash', hash).maybeSingle();
  if (!qr) return c.json({ success: false, error: 'QR no encontrado' }, 404);
  const pay = qr.payments as any;
  const expected = await signHmacSha256(`${pay.id}:${pay.amount}:${qr_token}`, c.env.PAYMENT_QR_SECRET);
  if (!isSame(expected, qr.signature)) return c.json({ success: false, error: 'Firma QR inválida' }, 403);
  if (pay.purpose === 'SUBSCRIPTION_UPGRADE') {
    if (c.env.PRO_TREASURY_SQL_VERIFIED !== 'true' || Number(c.env.SUBSCRIPTION_PRO_BOB) !== 59 ||
      !z.string().uuid().safeParse(c.env.PLATFORM_BANK_ACCOUNT_ID).success ||
      money(pay.amount) !== '59.00' || pay.target_store_id !== null)
      return c.json({ success: false, error: 'Cobro PRO pendiente de validación financiera' }, 503);
    const { data: verified, error: verificationError } = await db.from('payments')
      .select('requested_plan,currency').eq('id', pay.id).maybeSingle();
    if (verificationError || verified?.requested_plan !== 'PRO' || verified.currency !== 'BOB')
      return c.json({ success: false, error: 'Suscripción inválida' }, 409);
  }
  if (pay.purpose === 'ORDER_PAYMENT' && c.env.ORDER_ESCROW_ATOMIC_VERIFIED !== 'true')
    return c.json({ success: false, error: 'Cobro de pedido pendiente de validar custodia atómica' }, 503);
  if (pay.purpose === 'ORDER_PAYMENT' && pay.status !== 'PAID') {
    try {
      const quote = await trustedOrderQuote(c, pay.reference_id);
      if (!quote.payable || quote.store_id !== pay.target_store_id || money(quote.amount) !== money(pay.amount)) {
        return c.json({ success: false, error: 'El pedido ya no admite el pago' }, 409);
      }
    } catch {
      return c.json({ success: false, error: 'No se pudo validar el pedido con MS4' }, 503);
    }
  }
  const { data, error } = await db.rpc('execute_qr_payment', { p_qr_token_hash: hash, p_account_id: acc.id, p_pin: pin });
  if (error) return c.json({ success: false, error: 'Error al procesar pago' }, 400);
  if (!data?.success) return c.json({ success: false, code: data?.code || 'PAYMENT_FAILED' }, 400);
  if (pay.purpose === 'ORDER_PAYMENT') {
    const { data: escrow, error: escrowError } = await db.from('escrow_settlements')
      .select('id').eq('payment_id', pay.id).maybeSingle();
    if (escrowError || !escrow) {
      return c.json({ success: false, code: 'ESCROW_PENDING_RECONCILIATION' }, 503);
    }
  }
  return c.json({ success: true, data: { ...data, escrow_sync_pending: false } });
});
export default routes;
