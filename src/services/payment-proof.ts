import { createSupabaseAdmin } from '../utils/supabase';
import type { Env } from '../types';
export async function persistedPayment(env: Env, paymentId: string) {
 const db=createSupabaseAdmin(env);
 const {data:p,error}=await db.from('payments').select('id,purpose,reference_id,target_store_id,amount,currency,status,paid_at').eq('id',paymentId).maybeSingle();
 if(error||!p)throw new Error('PAYMENT_UNAVAILABLE');
 if(p.purpose!=='ORDER_PAYMENT'||p.status!=='PAID'||!p.paid_at||!Number.isFinite(Date.parse(p.paid_at)))throw new Error('PAYMENT_NOT_CONFIRMED');
 const {data:escrow,error:ee}=await db.from('escrow_settlements').select('id').eq('payment_id',p.id).maybeSingle();
 if(ee||!escrow)throw new Error('ESCROW_PENDING_RECONCILIATION');
 return {payment_id:p.id,order_id:p.reference_id,store_id:p.target_store_id,amount:String(p.amount),currency:p.currency,status:p.status,paid_at:p.paid_at};
}
