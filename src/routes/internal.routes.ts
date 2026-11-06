import { Hono } from 'hono';
import { createSupabaseAdmin } from '../utils/supabase';
import type { AppContext } from '../types';
import { processPaymentOutbox } from '../services/payment-outbox';
import { trustedOrderQuote } from '../services/ms4-client';

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

// ─── POST /process-outbox (claim atómico, sin envíos duplicados en paralelo) ───
internalRoutes.post('/process-outbox', async c => {
  const result = await processPaymentOutbox(c.env);
  return c.json(result, result.success ? 200 : 503);
});

// Repara pagos ya procesados que quedaron sin escrow por caída tras el RPC.
// No cobra nuevamente ni cambia el estado del pedido.
internalRoutes.post('/escrow/reconcile-paid',async c=>{
 const supabase=createSupabaseAdmin(c.env);
 const {data:payments,error}=await supabase.from('payments')
    .select('id,reference_id,target_store_id,payer_account_id,amount,currency')
    .eq('purpose','ORDER_PAYMENT').eq('status','PAID')
    .order('paid_at',{ascending:false}).limit(50);
 if(error)return c.json({success:false,error:'No se pudo consultar pagos'},500);
 let repaired=0,failed=0;
 for(const p of payments??[]){
  const {data:existing}=await supabase.from('escrow_settlements').select('id')
    .eq('payment_id',p.id).maybeSingle();
  if(existing)continue;
  // La identidad del comprador se consulta en MS4; puede ser distinta del pagador.
  let customerId:string|null=null;
  try {
    const quote = await trustedOrderQuote(c.env,p.reference_id);
    customerId = quote.customer_id;
  }catch{ /* reintento programado */ }
  if(!customerId){failed++;continue;}
  const {error:insertError}=await supabase.from('escrow_settlements').insert({
    payment_id:p.id,order_id:p.reference_id,store_id:p.target_store_id,
    customer_id:customerId,amount:p.amount,currency:p.currency,status:'HELD'
  });
  if(insertError){failed++;console.error('Reparación escrow falló',p.id,insertError.message);}
  else repaired++;
 }
 return c.json({success:true,checked:(payments??[]).length,repaired,failed});
});

// ─── POST /escrow/delivered ───────────────────────────────────────────────────
internalRoutes.post('/escrow/delivered', c => c.json({
  success: false, error: 'El evento de llegada no acredita recepción'
}, 503));

// ─── POST /escrow/dispute ─────────────────────────────────────────────────────
internalRoutes.post('/escrow/dispute', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.order_id !== 'string' || body?.action !== 'FREEZE') {
    return c.json({ success: false, error: 'Se requiere order_id y acción FREEZE' }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);
  const { data, error } = await supabase.rpc('resolve_escrow_dispute', {
    p_order_id: body.order_id,
    p_action: body.action,
    p_notes: body.reason || 'Disputa reportada por el comprador',
  });

  if (error || !data?.success) {
    return c.json({ success: false, error: error?.message || data?.error }, 400);
  }

  return c.json({ success: true, data });
});

// ─── POST /escrow/process-settlements ─────────────────────────────────────────
internalRoutes.post('/escrow/process-settlements', async (c) => {
  if (c.env.ESCROW_AUTO_SETTLEMENT_VERIFIED !== 'true') {
    return c.json({ success: false, error: 'Liquidación automática deshabilitada' }, 503);
  }
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
