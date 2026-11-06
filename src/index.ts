import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppContext } from './types';
import { dispatchPaymentOutbox } from './services/payment-outbox';
import type { Env } from './types';

import bankRoutes from './routes/bank.routes';
import qrRoutes from './routes/qr.routes';
import internalRoutes from './routes/internal.routes';
import escrowRoutes from './routes/escrow.routes';
import planCheckRoutes from './routes/plan-check.routes';
import profileRoutes from './routes/profile.routes';
import subscriptionRoutes from './routes/subscriptions.routes';

export const app = new Hono<AppContext>();

app.use('*', async (c, next) => {
  const started = Date.now();
  await next();
  console.info({ component: 'MS6_HTTP', method: c.req.method, route: c.req.routePath,
    status: c.res.status, elapsedMs: Date.now() - started });
});
app.use('*', cors());

app.get('/health', (c) => c.json({
  service: 'livemarket-ms-payments',
  status: 'ok',
  timestamp: new Date().toISOString(),
}));

app.route('/api/bank', bankRoutes);
app.route('/api/qr', qrRoutes);
app.route('/api/internal', internalRoutes);
app.route('/api/internal/store-plan', planCheckRoutes);
app.route('/api/escrow', escrowRoutes);
app.route('/api/profile', profileRoutes);
app.route('/api/subscriptions', subscriptionRoutes);

app.notFound((c) => c.json({ success: false, error: 'Recurso no encontrado' }, 404));
app.onError((err, c) => {
  console.error(`[Error MS6]: ${err.message}`);
  return c.json({ success: false, error: 'Error interno del servidor de pagos' }, 500);
});

export default {
  fetch: app.fetch,
  scheduled(_event: unknown, env: Env, ctx: {waitUntil(promise:Promise<unknown>):void}) {
    ctx.waitUntil(dispatchPaymentOutbox(env));
  },
};
