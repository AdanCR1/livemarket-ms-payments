import assert from 'node:assert/strict';
import {test} from 'node:test';
import worker from '../src/index.ts';
import {processPaymentOutbox} from '../src/services/payment-outbox.ts';
const env={SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',PAYMENTS_INTERNAL_KEY:'fixture-internal',MS4_URL:'https://orders.invalid'};
test('Cron ejecuta el consumidor fuera del navegador',async t=>{
 let promise,calls=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls++;assert.ok(String(url).endsWith('/ms6_claim_order_payment_events_v3'));assert.equal(JSON.parse(options.body).p_payment_id,null);return Response.json([]);});
 worker.scheduled({},env,{waitUntil:p=>promise=p});
 assert.equal((await promise).success,true);assert.equal(calls,1);
});
test('recuperación selectiva no solicita otros pagos',async t=>{
 const payment_id=crypto.randomUUID();
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.deepEqual(JSON.parse(options.body),{p_limit:5,p_payment_id:payment_id,p_outbox_id:null});return Response.json([]);});
 assert.equal((await processPaymentOutbox(env,{payment_id})).claimed,0);
});
test('MS6 temporalmente indisponible no acusa entrega',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({code:'DB_DOWN'},{status:503}));
 const r=await processPaymentOutbox(env);assert.equal(r.success,false);assert.equal(r.code,'OUTBOX_CLAIM_UNAVAILABLE');
});
test('administración rechaza filtros inválidos y requiere autenticación',async()=>{
 const send=(body,key)=>worker.fetch(new Request('https://payments.invalid/api/internal/process-outbox',{method:'POST',headers:{'Content-Type':'application/json','X-Internal-Key':key},body:JSON.stringify(body)}),env,{});
 assert.equal((await send({},'wrong')).status,401);
 assert.equal((await send({payment_id:'invalid'},env.PAYMENTS_INTERNAL_KEY)).status,400);
 assert.equal((await send({payment_id:crypto.randomUUID(),outbox_id:crypto.randomUUID()},env.PAYMENTS_INTERNAL_KEY)).status,400);
});

