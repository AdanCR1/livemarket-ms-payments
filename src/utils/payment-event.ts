/** El ID del evento permanece estable aunque el ID del registro outbox sea distinto. */
export function paymentEvent(payload: unknown): Record<string, string> | null {
  if (!payload || typeof payload !== 'object') return null;
  const input = payload as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const fields = ['event_id', 'order_id', 'payment_id'] as const;
  if (fields.some(field => typeof input[field] !== 'string' || !uuid.test(input[field] as string))) return null;
  if (input.currency !== 'BOB' || !['PAID', 'FAILED'].includes(String(input.status))) return null;
  const amount = typeof input.amount === 'number' || typeof input.amount === 'string' ? String(input.amount) : '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  return { event_id: input.event_id as string, order_id: input.order_id as string,
    payment_id: input.payment_id as string, status: input.status as string, currency: 'BOB',
    amount: whole + '.' + fraction.padEnd(2, '0') };
}
