import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppContext } from './types';
import bankRoutes from './routes/bank.routes';
import qrRoutes from './routes/qr.routes';
import internalRoutes from './routes/internal.routes';
import escrowRoutes from './routes/escrow.routes';

const app = new Hono<AppContext>();

app.use('*', logger());
app.use('*', cors());

app.get('/health', (c) => {
  return c.json({
    service: 'livemarket-ms-payments',
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

app.route('/api/bank', bankRoutes);
app.route('/api/qr', qrRoutes);
app.route('/api/internal', internalRoutes);
app.route('/api/escrow', escrowRoutes);

app.notFound((c) => c.json({ success: false, error: 'Recurso no encontrado' }, 404));

app.onError((err, c) => {
  console.error(`[Error MS6]: ${err.message}`);
  return c.json({ success: false, error: 'Error interno del servidor de pagos' }, 500);
});

export default app;