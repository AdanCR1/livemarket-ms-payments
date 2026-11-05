import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { auth } from '../middleware/auth';
import { createSupabaseAdmin } from '../utils/supabase';
import type { AppContext } from '../types';

const routes = new Hono<AppContext>();
routes.use('*', auth);

// Solo acepta QR MC-ACC emitido para LA MISMA cuenta del usuario autenticado.
// No se almacenan ni confían imágenes externas ni números arbitrarios.
function qrAccountId(payload: string): string | null {
  const match = /^MC-ACC-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-/i.exec(payload);
  return match ? match[1].toLowerCase() : null;
}

routes.get('/receiving-qr', async c => {
  const owner = c.get('actor').id;
  const db = createSupabaseAdmin(c.env);
  const { data: account, error: accountError } = await db.from('bank_accounts')
    .select('id,account_holder,account_number,currency,is_active')
    .eq('owner_user_id', owner).maybeSingle();
  if (accountError) return c.json({ success: false, error: 'No se pudo consultar la cuenta' }, 500);
  if (!account) return c.json({ success: true, data: { account: null, qr_payload: null } });
  const { data: saved, error } = await db.from('user_receiving_qrs')
    .select('qr_payload,version,updated_at') .eq('owner_user_id', owner).maybeSingle();
  if (error) return c.json({ success: false, error: 'No se pudo consultar QR' }, 500);
  return c.json({ success: true, data: { account, qr_payload: saved?.qr_payload ?? null,
    version: saved?.version ?? 0, updated_at: saved?.updated_at ?? null } });
});

routes.put('/receiving-qr', zValidator('json', z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
  qr_payload: z.string().min(45).max(1024),
})), async c => {
  const actor = c.get('actor');
  const { email, password, qr_payload } = c.req.valid('json');
  const accountId = qrAccountId(qr_payload);
  if (!accountId) return c.json({ success: false, error: 'QR incompatible con Solari (MC-ACC)' }, 400);
  // Reautenticación: evita que el JWT robado sea suficiente para cambiar el destino.
  const ms1Base = (c.env as any).MS1_URL;
  if (typeof ms1Base !== 'string' || !ms1Base.startsWith('https://') && !ms1Base.startsWith('http://localhost')) {
    return c.json({ success: false, error: 'MS1_URL no configurado de forma segura' }, 503);
  }
  let loginData: any;
  try {
    const res = await fetch(`${ms1Base.replace(/\/+$/, '')}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(8000),
    });
    loginData = await res.json().catch(() => null);
    if (!res.ok || !loginData?.success || loginData?.data?.user_id !== actor.id) {
      return c.json({ success: false, error: 'Credenciales incorrectas o cuenta distinta' }, 403);
    }
  } catch { return c.json({ success: false, error: 'No se pudo verificar la contraseña con MS1' }, 503); }
  const db = createSupabaseAdmin(c.env);
  const { data: account, error: aerr } = await db.from('bank_accounts')
    .select('id,is_active').eq('owner_user_id', actor.id).maybeSingle();
  if (aerr || !account?.is_active) return c.json({ success: false, error: 'Cuenta bancaria no disponible' }, 403);
  if (account.id.toLowerCase() !== accountId) {
    return c.json({ success: false, error: 'El QR pertenece a otra cuenta bancaria' }, 403);
  }
  const { data: prior } = await db.from('user_receiving_qrs').select('version')
    .eq('owner_user_id', actor.id).maybeSingle();
  const { error } = await db.from('user_receiving_qrs').upsert({
    owner_user_id: actor.id, account_id: account.id,
    qr_payload, version: (prior?.version ?? 0) + 1, updated_at: new Date().toISOString()
  }, { onConflict: 'owner_user_id' });
  if (error) return c.json({ success: false, error: 'No se pudo guardar el QR' }, 500);
  return c.json({ success: true, data: { updated: true } });
});

export default routes;
