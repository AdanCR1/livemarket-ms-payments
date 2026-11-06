import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paymentEvent } from '../src/utils/payment-event.ts';
import { processPaymentOutbox } from '../src/services/payment-outbox.ts';
import { trustedOrderQuote } from '../src/services/ms4-client.ts';

const payload = { event_id: crypto.randomUUID(), payment_id: crypto.randomUUID(), order_id: crypto.randomUUID(),
  amount:20, status:'PAID', currency:'BOB' };
const event = { id:crypto.randomUUID(), aggregate_id:payload.payment_id, destination:'MS4',event_type:'PAYMENT_SUCCEEDED',
  payload, claim_token:crypto.randomUUID() };
const env = { SUPABASE_URL:'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY:'fixture-key',
  MS4_URL:'https://orders.invalid',PAYMENTS_INTERNAL_KEY:'fixture-internal' };

test('normaliza dinero sin cambiar la identidad del evento', () => {
  assert.equal(paymentEvent(payload).event_id,payload.event_id);
  assert.equal(paymentEvent(payload).amount,'20.00');
  for (const amount of [NaN,Infinity,-1,'1.001','invalid',{},null]) {
    assert.equal(paymentEvent({...payload,amount}),null);
  }
});
for (const scenario of ['sent','logical-failure','ack-failure','no-escrow','bad-payload']) {
  test('outbox ' + scenario, async t => {
    let sends = 0;
    let ack;
    t.mock.method(globalThis,'fetch',async (url, options) => {
      const path = new URL(url).pathname;
      if(path.endsWith('/rpc/ms6_claim_order_payment_events_v3'))
        return Response.json([{...event,payload:scenario==='bad-payload'?{...payload,amount:'bad'}:payload}]);
      if(path.endsWith('/payments')) return Response.json({id:payload.payment_id,purpose:'ORDER_PAYMENT',reference_id:payload.order_id,target_store_id:crypto.randomUUID(),amount:20,currency:'BOB',status:'PAID',paid_at:'2026-11-06T03:39:43Z'});
      if(path.endsWith('/escrow_settlements'))
        return Response.json(scenario==='no-escrow'?null:{id:crypto.randomUUID()});
      if(path.endsWith('/api/internal/payments/events')) {
        sends++;
        assert.equal(options.headers['X-Internal-Key'],env.PAYMENTS_INTERNAL_KEY);
        assert.equal(options.redirect,'manual');
        assert.equal(JSON.parse(options.body).amount,'20.00');
        assert.equal(JSON.parse(options.body).event_id,payload.event_id);
        return Response.json({success:scenario!=='logical-failure'});
      }
      if(path.endsWith('/rpc/ms6_ack_payment_event_v2')) {
        ack=JSON.parse(options.body);
        assert.equal(ack.p_claim_token,event.claim_token);
        return scenario==='ack-failure'?Response.json({code:'fixture'},{status:503}):Response.json(true);
      }
      throw new Error('Ruta inesperada');
    });
    const result = await processPaymentOutbox(env);
    assert.equal(result.sent,scenario==='sent'?1:0);
    assert.equal(result.ack_failed,scenario==='ack-failure'?1:0);
    assert.equal(sends,['no-escrow','bad-payload'].includes(scenario)?0:1);
    assert.equal(ack.p_success,['sent','ack-failure'].includes(scenario));
  });
}
test('la misma función valida la cotización y descarta redirecciones', async t => {
  let valid = true;
  t.mock.method(globalThis,'fetch',async () => valid ? Response.json({success:true,data:{
    id:payload.order_id,customer_id:crypto.randomUUID(),store_id:crypto.randomUUID(),currency:'BOB',amount:'20',payable:false,
  }}) : new Response(null,{status:302,headers:{Location:'https://other.invalid'}}));
  assert.equal((await trustedOrderQuote(env,payload.order_id)).payable,false);
  valid=false;
  await assert.rejects(trustedOrderQuote(env,payload.order_id), /MS4_HTTP_302/);
});
