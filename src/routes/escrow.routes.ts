import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { auth } from '../middleware/auth';
import { createSupabaseAdmin } from '../utils/supabase';
import type { AppContext } from '../types';

const escrowRoutes = new Hono<AppContext>();

// ─── 1. POST /bind-qr (Asociar QR de cobro/reembolso a una orden) ──────────────
escrowRoutes.post(
  '/bind-qr',
  auth,
  zValidator(
    'json',
    z.object({
      order_id: z.string().uuid(),
      qr_image_url: z.string().url(),
    })
  ),
  async (c) => {
    const actor = c.get('actor');
    const { order_id, qr_image_url } = c.req.valid('json');
    const supabase = createSupabaseAdmin(c.env);

    const updatePayload: Record<string, string> =
      actor.role === 'B2B'
        ? { seller_qr_image_url: qr_image_url }
        : { buyer_qr_image_url: qr_image_url };

    const { data, error } = await supabase
      .from('escrow_settlements')
      .update(updatePayload)
      .eq('order_id', order_id)
      .select('id, order_id, status, seller_qr_image_url, buyer_qr_image_url')
      .single();

    if (error || !data) {
      return c.json({ success: false, error: 'No se encontró el registro de custodia' }, 404);
    }

    return c.json({ success: true, data });
  }
);

// ─── 2. GET /detail/:order_id (Consultar estado de retención y QR de liquidación)
escrowRoutes.get('/detail/:order_id', auth, async (c) => {
  const orderId = c.req.param('order_id');
  const supabase = createSupabaseAdmin(c.env);

  const { data, error } = await supabase
    .from('escrow_settlements')
    .select('*')
    .eq('order_id', orderId)
    .single();

  if (error || !data) {
    return c.json({ success: false, error: 'Custodia no encontrada' }, 404);
  }

  return c.json({ success: true, data });
});

// ─── 3. POST /settle (Ejecutar Payout al QR de la Tienda o Reembolso al B2C) ──
escrowRoutes.post(
  '/settle',
  auth,
  zValidator(
    'json',
    z.object({
      order_id: z.string().uuid(),
      action: z.enum(['RELEASE_TO_SELLER', 'REFUND_TO_BUYER']),
      notes: z.string().optional(),
    })
  ),
  async (c) => {
    const actor = c.get('actor');
    if (actor.role !== 'B2B') {
      return c.json({ success: false, error: 'Operación restringida' }, 403);
    }

    const { order_id, action, notes } = c.req.valid('json');
    const supabase = createSupabaseAdmin(c.env);

    const { data, error } = await supabase.rpc('resolve_escrow_dispute', {
      p_order_id: order_id,
      p_action: action,
      p_notes: notes || 'Liquidación procesada mediante QR bancario de destino',
    });

    if (error || !data?.success) {
      return c.json({ success: false, error: error?.message || data?.error }, 400);
    }

    return c.json({ success: true, data });
  }
);

export default escrowRoutes;