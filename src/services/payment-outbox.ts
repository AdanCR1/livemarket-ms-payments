import { createSupabaseAdmin } from '../utils/supabase';
import { paymentEvent } from '../utils/payment-event';
import { callMS4 } from './ms4-client';
import { persistedPayment } from './payment-proof';
import type { Env } from '../types';
export type OutboxTarget={payment_id?:string;outbox_id?:string};
export async function processPaymentOutbox(env: Env,target:OutboxTarget={}) {
 const db=createSupabaseAdmin(env);
 const {data:events,error}=await db.rpc('ms6_claim_order_payment_events_v3',{
  p_limit:5,p_payment_id:target.payment_id??null,p_outbox_id:target.outbox_id??null
 });
 if(error||!Array.isArray(events))return {success:false,code:'OUTBOX_CLAIM_UNAVAILABLE'};
 let sent=0,failed=0,ack_failed=0;
 for(const event of events){
  if(typeof event.claim_token!=='string'){ack_failed++;continue;}
  let delivered=false,reason='OUTBOX_INVALID_PAYMENT_EVENT';
  try{
   const payload=paymentEvent(event.payload);
   if(event.destination!=='MS4'||event.event_type!=='PAYMENT_SUCCEEDED'||!payload||payload.payment_id!==event.aggregate_id)throw Error(reason);
   const proof=await persistedPayment(env,payload.payment_id);
   if(proof.order_id!==payload.order_id||proof.currency!==payload.currency||Number(proof.amount)!==Number(payload.amount)||payload.status!=='PAID')throw Error('PAYMENT_PROOF_CONFLICT');
   await callMS4(env,'/api/internal/payments/events','POST',{...payload,paid_at:proof.paid_at});
   delivered=true;
  }catch(e){reason=e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'OUTBOX_DELIVERY_FAILED';}
  const ack=await db.rpc('ms6_ack_payment_event_v2',{p_event_id:event.id,p_claim_token:event.claim_token,p_success:delivered,p_error:delivered?'':reason});
  if(ack.error||ack.data!==true)ack_failed++;
  else if(delivered)sent++;else failed++;
  console.info({component:'MS6_OUTBOX',eventId:event.id,delivered,ack:!ack.error&&ack.data===true,code:delivered?'DELIVERED':reason});
 }
 return {success:failed===0&&ack_failed===0,claimed:events.length,sent,failed,ack_failed};
}
export async function dispatchPaymentOutbox(env:Env,target:OutboxTarget={}){
 try{return await processPaymentOutbox(env,target);}catch{console.warn({component:'MS6_OUTBOX',code:'DISPATCH_UNAVAILABLE'});return {success:false};}
}
