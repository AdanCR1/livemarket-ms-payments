import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { auth } from '../middleware/auth';
import { createSupabaseAdmin } from '../utils/supabase';
import type { AppContext } from '../types';

const bankRoutes = new Hono<AppContext>();

// Todas las operaciones bancarias requieren autenticación
bankRoutes.use('*', auth);

// ─── POST /account (Crear tu cuenta bancaria personal simulada) ─────────────────
bankRoutes.post(
    '/account',
    zValidator(
        'json',
        z.object({
            account_holder: z.string().min(1).max(160),
            account_number: z.string().min(6).max(20),
            pin: z.string().regex(/^\d{4,6}$/, 'El PIN debe ser de 4 a 6 dígitos numéricos'),
            initial_balance: z.number().nonnegative().default(100000),
        })
    ),
    async (c) => {
        const actor = c.get('actor');
        const { account_holder, account_number, pin, initial_balance } = c.req.valid('json');
        const supabase = createSupabaseAdmin(c.env);

        // 1. Obtener el hash seguro desde PostgreSQL
        const { data: hashedPin, error: hashError } = await supabase.rpc('hash_pin', {
            p_pin: pin,
        });

        if (hashError || !hashedPin) {
            return c.json({ success: false, error: 'Error al procesar PIN de seguridad' }, 500);
        }

        // 2. Insertar con el hash real
        const { data, error } = await supabase
            .from('bank_accounts')
            .insert({
                owner_user_id: actor.id,
                account_number,
                account_holder,
                pin_hash: hashedPin,
                balance: initial_balance,
                currency: 'BOB',
            })
            .select('id, account_number, account_holder, balance, currency, is_active')
            .single();

        if (error) {
            return c.json({ success: false, error: error.message }, 409);
        }

        return c.json({ success: true, data }, 201);
    }
);

// ─── GET /account (Consultar saldo y estado de mi cuenta) ─────────────────────
bankRoutes.get('/account', async (c) => {
    const actor = c.get('actor');
    const supabase = createSupabaseAdmin(c.env);

    const { data, error } = await supabase
        .from('bank_accounts')
        .select('id, account_number, account_holder, balance, currency, is_active')
        .eq('owner_user_id', actor.id)
        .single();

    if (error || !data) {
        return c.json({ success: false, error: 'Cuenta bancaria no encontrada' }, 404);
    }

    return c.json({ success: true, data });
});

// ─── POST /account/topup (Recargar saldo ficticio) ───────────────────────────
bankRoutes.post(
    '/account/topup',
    zValidator(
        'json',
        z.object({
            amount: z.number().positive(),
            operation_key: z.string().uuid(),
        })
    ),
    async (c) => {
        const actor = c.get('actor');
        const { amount, operation_key } = c.req.valid('json');
        const supabase = createSupabaseAdmin(c.env);

        const { data: acc } = await supabase
            .from('bank_accounts')
            .select('id')
            .eq('owner_user_id', actor.id)
            .single();

        if (!acc) {
            return c.json({ success: false, error: 'Cuenta no encontrada' }, 404);
        }

        const { data, error } = await supabase.rpc('credit_demo_balance', {
            p_account_id: acc.id,
            p_amount: amount,
            p_operation_key: operation_key,
        });

        if (error) {
            return c.json({ success: false, error: error.message }, 400);
        }

        return c.json({ success: true, data });
    }
);

export default bankRoutes;