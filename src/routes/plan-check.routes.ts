import { Hono } from 'hono';
import { createSupabaseAdmin } from '../utils/supabase';
import type { AppContext } from '../types';
const r = new Hono<AppContext>();
r.use('*', async(c,next)=>{
 const k=c.req.header('X-Internal-Key');
 if(!c.env.PAYMENTS_INTERNAL_KEY||!k||k!==c.env.PAYMENTS_INTERNAL_KEY) return c.json({success:false,error:'No autorizado'},401);
 await next();
});
r.get('/:storeId',async c=>{
 const id=c.req.param('storeId');
 if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))return c.json({success:false,error:'ID inválido'},400);
 const db=createSupabaseAdmin(c.env);
 const {data,error}=await db.from('store_subscriptions').select('plan,status,current_period_end,trial_end_at,version')
  .eq('store_id',id).maybeSingle();
 if(error)return c.json({success:false,error:'Error de suscripción'},503);
 const valid=!!data&&['PRO','ENTERPRISE'].includes(String(data.plan))&&(
  (data.status==='ACTIVE'&&!!data.current_period_end&&Date.parse(data.current_period_end)>Date.now())||
  (data.status==='TRIALING'&&!!data.trial_end_at&&Date.parse(data.trial_end_at)>Date.now())
 );
 return c.json({success:true,data:{store_id:id,can_accept_orders:valid,plan:data?.plan??'FREE',status:data?.status??'INACTIVE'}});
});
export default r;
