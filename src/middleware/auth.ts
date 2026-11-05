import { createMiddleware } from 'hono/factory';
import { verify } from 'hono/jwt';
import type { AppContext, Actor } from '../types';

export const auth = createMiddleware<AppContext>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const token = /^Bearer (.+)$/i.exec(authHeader || '')?.[1];

  if (!token) {
    return c.json({ success: false, error: 'Bearer token requerido' }, 401);
  }

  try {
    const payload = (await verify(token, c.env.JWT_SECRET, 'HS256')) as Record<string, unknown>;

    const role = payload.role as string;
    if (payload.iss !== 'ms1-auth' || typeof payload.exp !== 'number' ||
        payload.exp <= Date.now() / 1000 || typeof payload.sub !== 'string' ||
        !['B2C', 'B2B', 'DRIVER'].includes(role)) {
      return c.json({ success: false, error: 'Claims de token inválidos' }, 401);
    }

    c.set('actor', {
      id: payload.sub,
      role: role as Actor['role'],
      storeId: typeof payload.store_id === 'string' ? payload.store_id : undefined,
    });

    await next();
  } catch {
    return c.json({ success: false, error: 'Token inválido o expirado' }, 401);
  }
});
