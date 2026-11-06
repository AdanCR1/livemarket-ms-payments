import assert from 'node:assert/strict';
import { test } from 'node:test';
import { app } from '../src/index.ts';

test('los logs de escaneo usan la plantilla de ruta y omiten token y query', async t => {
  const records=[];
  t.mock.method(console,'info',entry=>records.push(entry));
  const response=await app.request('/api/qr/scan/MC-QR-sensitive-token?pin=fixture',{},{});
  assert.equal(response.status,401);
  const serialized=JSON.stringify(records);
  assert.ok(!serialized.includes('sensitive-token'));
  assert.ok(!serialized.includes('fixture'));
  assert.ok(records.some(entry=>entry.route==='/api/qr/scan/:token'));
});
