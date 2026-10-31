import { Hono } from 'hono';
import { createSupabaseAdmin } from '../utils/supabase';
import type { AppContext } from '../types';

const internalRoutes = new Hono<AppContext>();

// Middleware M2M obligatorio
internalRoutes.use('*', async (c, next) => {
  const key = c.req.header('X-Internal-Key');
  if (!key || key !== c.env.PAYMENTS_INTERNAL_KEY) {
    return c.json({ success: false, error: 'No autorizado' }, 401);
  }
  await next();
});

// ─── POST /expire ─────────────────────────────────────────────────────────────
internalRoutes.post('/expire', async (c) => {
  const supabase = createSupabaseAdmin(c.env);
  const { data, error } = await supabase.rpc('expire_ms6_records');

  if (error) {
    return c.json({ success: false, error: error.message }, 500);
  }

  return c.json({ success: true, data });
});

// ─── POST /process-outbox ─────────────────────────────────────────────────────
internalRoutes.post('/process-outbox', async (c) => {
  const supabase = createSupabaseAdmin(c.env);

  const { data: pendingEvents, error } = await supabase
    .from('payment_outbox')
    .select('*')
    .in('status', ['PENDING', 'FAILED'])
    .lte('next_retry_at', new Date().toISOString())
    .limit(20);

  if (error || !pendingEvents || pendingEvents.length === 0) {
    return c.json({ success: true, processed: 0 });
  }

  let processedCount = 0;

  for (const ev of pendingEvents) {
    try {
      if (ev.destination === 'MS4' && ev.event_type === 'PAYMENT_SUCCEEDED') {
        const res = await fetch(`${c.env.MS4_URL.replace(/\/$/, '')}/api/internal/payments/events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': c.env.PAYMENTS_INTERNAL_KEY,
          },
          body: JSON.stringify(ev.payload),
        });

        if (res.ok) {
          await supabase
            .from('payment_outbox')
            .update({ status: 'SENT', sent_at: new Date().toISOString() })
            .eq('id', ev.id);
          processedCount++;
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      }
    } catch (err: any) {
      await supabase
        .from('payment_outbox')
        .update({
          status: 'FAILED',
          attempts: ev.attempts + 1,
          next_retry_at: new Date(Date.now() + Math.pow(2, ev.attempts + 1) * 60000).toISOString(),
          last_error: err.message,
        })
        .eq('id', ev.id);
    }
  }

  return c.json({ success: true, processed: processedCount });
});

// ─── POST /escrow/delivered ───────────────────────────────────────────────────
internalRoutes.post('/escrow/delivered', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.order_id) {
    return c.json({ success: false, error: 'order_id requerido' }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);
  const minutes = body.timer_minutes || 5;

  const { data, error } = await supabase.rpc('start_escrow_timer', {
    p_order_id: body.order_id,
    p_minutes: minutes,
  });

  if (error || !data.success) {
    return c.json({ success: false, error: error?.message || data?.error }, 400);
  }

  return c.json({ success: true, data });
});

// ─── POST /escrow/dispute ─────────────────────────────────────────────────────
internalRoutes.post('/escrow/dispute', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.order_id || !body?.action) {
    return c.json({ success: false, error: 'order_id y action requeridos' }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);
  const { data, error } = await supabase.rpc('resolve_escrow_dispute', {
    p_order_id: body.order_id,
    p_action: body.action,
    p_notes: body.reason || 'Disputa reportada por el comprador',
  });

  if (error || !data.success) {
    return c.json({ success: false, error: error?.message || data?.error }, 400);
  }

  return c.json({ success: true, data });
});

// ─── POST /escrow/process-settlements ─────────────────────────────────────────
internalRoutes.post('/escrow/process-settlements', async (c) => {
  const supabase = createSupabaseAdmin(c.env);

  const { data: readyOrders, error } = await supabase
    .from('escrow_settlements')
    .select('*')
    .eq('status', 'TIMING_OUT')
    .lte('release_due_at', new Date().toISOString());

  if (error || !readyOrders || readyOrders.length === 0) {
    return c.json({ success: true, settled: 0 });
  }

  let settledCount = 0;
  for (const esc of readyOrders) {
    const { data } = await supabase.rpc('resolve_escrow_dispute', {
      p_order_id: esc.order_id,
      p_action: 'RELEASE_TO_SELLER',
      p_notes: 'Liberación automática: periodo finalizado sin reclamos',
    });

    if (data?.success) settledCount++;
  }

  return c.json({ success: true, settled: settledCount });
});

export default internalRoutes;