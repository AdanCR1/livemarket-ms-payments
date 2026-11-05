import { Hono } from 'hono';
import { auth } from '../middleware/auth';
import { createSupabaseAdmin } from '../utils/supabase';
import type { AppContext } from '../types';

const routes = new Hono<AppContext>();
routes.use('*', auth);

function storeId(c: any): string | null {
  const actor = c.get('actor');
  if (actor?.role !== 'B2B') return null;
  return typeof actor.storeId === 'string' && actor.storeId.length > 0 ? actor.storeId : null;
}

// Devuelve únicamente la suscripción de la tienda propietaria de la sesión.
routes.get('/me', async (c) => {
  const owner = storeId(c);
  if (!owner) return c.json({ success: false, error: 'Solo comercios B2B' }, 403);
  const db = createSupabaseAdmin(c.env);
  const { data, error } = await db.from('store_subscriptions')
    .select('plan,status,current_period_start,current_period_end,trial_end_at,version')
    .eq('store_id', owner).maybeSingle();
  if (error) return c.json({ success: false, error: 'No se pudo consultar la suscripción' }, 503);
  const valid = !!data && ['PRO','ENTERPRISE'].includes(String(data.plan)) && (
    (data.status === 'ACTIVE' && !!data.current_period_end && Date.parse(data.current_period_end) > Date.now()) ||
    (data.status === 'TRIALING' && !!data.trial_end_at && Date.parse(data.trial_end_at) > Date.now())
  );
  return c.json({ success: true, data: {
    store_id: owner,
    plan: data?.plan ?? 'FREE',
    status: data?.status ?? 'INACTIVE',
    can_accept_orders: valid,
    current_period_end: data?.current_period_end ?? null,
    trial_end_at: data?.trial_end_at ?? null,
    prices: { PRO: Number(c.env.SUBSCRIPTION_PRO_BOB) === 59 ? 59 : null, ENTERPRISE: null },
    currency: 'BOB', period_days: 30,
  }});
});

// La consulta por ID jamás expone pagos de otra tienda.
routes.get('/payments/:id', async (c) => {
  const owner = storeId(c);
  if (!owner) return c.json({ success: false, error: 'Solo comercios B2B' }, 403);
  const id = c.req.param('id');
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)) return c.json({success:false,error:'ID inválido'},400);
  const db = createSupabaseAdmin(c.env);
  const { data, error } = await db.from('payments')
    .select('id,purpose,reference_id,requested_plan,status,amount,currency,paid_at,created_at')
    .eq('id', id).eq('reference_id', owner).eq('purpose', 'SUBSCRIPTION_UPGRADE')
    .maybeSingle();
  if (error) return c.json({success:false,error:'No se pudo consultar pago'},503);
  if (!data) return c.json({success:false,error:'Pago no encontrado'},404);
  return c.json({success:true,data});
});

export default routes;
