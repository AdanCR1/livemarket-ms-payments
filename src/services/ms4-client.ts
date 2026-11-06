import type { Env } from '../types';

export async function callMS4(env: Env, path: string, method: 'GET' | 'POST' = 'GET', body?: unknown) {
  let base: URL;
  try {
    base = new URL(env.MS4_URL.trim());
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
        (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname))))
      throw new Error();
    if (!env.PAYMENTS_INTERNAL_KEY) throw new Error();
  } catch { throw new Error('MS4_CONFIG_INVALID'); }
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(base.origin + path, {
      method, headers: { 'X-Internal-Key': env.PAYMENTS_INTERNAL_KEY, Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual', signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    console.warn({ component: 'MS6_MS4', host: base.host, elapsedMs: Date.now() - started,
      code: error instanceof Error && ['AbortError','TimeoutError'].includes(error.name) ? 'MS4_TIMEOUT' : 'MS4_NETWORK_ERROR' });
    throw new Error('MS4_UNAVAILABLE');
  }
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch {}
  if (!response.ok || result?.success !== true) {
    console.warn({ component: 'MS6_MS4', host: base.host, status: response.status,
      elapsedMs: Date.now() - started, cloudflareCode: /error code:\s*(\d{4})/i.exec(text)?.[1] ?? null });
    const code = typeof result?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(result.code)
      ? result.code : 'MS4_HTTP_' + response.status;
    throw new Error(code);
  }
  return result;
}

export async function trustedOrderQuote(env: Env, orderId: string) {
  const result = await callMS4(env, '/api/internal/orders/' + encodeURIComponent(orderId) + '/payment-quote');
  const order = result.data;
  if (!order || order.id !== orderId || typeof order.payable !== 'boolean' ||
      typeof order.customer_id !== 'string' || typeof order.store_id !== 'string' ||
      order.currency !== 'BOB' || !Number.isFinite(Number(order.amount)) || Number(order.amount) < 0)
    throw new Error('MS4_INVALID_QUOTE');
  return order;
}
