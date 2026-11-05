import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';

const origin = process.env.MARKETCLOUD_MS6_DEV_ORIGIN || 'http://127.0.0.1:8787';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Usar solo MS6 local');
const store = randomUUID();
const id = randomUUID();

function token(role) {
  assert.ok(process.env.JWT_SECRET, 'Configura JWT_SECRET de MS6 DEV');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: id, role, store_id: store, iss: 'ms1-auth', exp: Math.floor(Date.now() / 1000) + 60,
  })).toString('base64url');
  const signature = createHmac('sha256', process.env.JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function post(path, body, role) {
  const headers = { 'Content-Type': 'application/json' };
  if (role) headers.Authorization = `Bearer ${token(role)}`;
  return fetch(`${origin}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
}

const pro = { purpose: 'SUBSCRIPTION_UPGRADE', requested_plan: 'PRO', reference_id: store, idempotency_key: randomUUID() };
const guard = await post('/api/escrow/settle', { order_id: id, action: 'RELEASE_TO_SELLER' }, 'B2B');
assert.equal(guard.status, 403, 'Ejecuta primero el Worker con las guardias C1');
for (const [label, role, fields, expected] of [
  ['rechaza QR anónimo', null, {}, 401],
  ['rechaza QR B2C', 'B2C', {}, 403],
  ['rechaza otra tienda', 'B2B', { reference_id: randomUUID() }, 403],
  ['rechaza Enterprise', 'B2B', { requested_plan: 'ENTERPRISE' }, 400],
  ['rechaza monto del cliente', 'B2B', { amount: 0.01 }, 400],
  ['rechaza destino del cliente', 'B2B', { target_store_id: randomUUID() }, 400],
  ['mantiene PRO cerrado sin auditoría transaccional', 'B2B', {}, 503],
]) {
  test(label, async () => assert.equal((await post('/api/qr/generate', { ...pro, ...fields }, role)).status, expected));
}
test('rechaza resolución pública incluso con rol comercio', async () => {
  assert.equal((await post('/api/escrow/settle', { order_id: id, action: 'RELEASE_TO_SELLER' }, 'B2B')).status, 403);
});
