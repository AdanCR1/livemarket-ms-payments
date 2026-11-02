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

        // 3. Registrar la transacción inicial en el ledger (si hubo saldo inicial)
        if (initial_balance > 0) {
            await supabase.from('bank_transactions').insert({
                account_id: data.id,
                tx_type: 'DEPOSIT',
                amount: initial_balance,
                balance_after: initial_balance,
                description: 'Depósito inicial de apertura de cuenta',
            });
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

// ─── GET /transactions (Historial de movimientos de MI cuenta) ───────────────
bankRoutes.get('/transactions', async (c) => {
    const actor = c.get('actor');
    const supabase = createSupabaseAdmin(c.env);

    // 1. Resolver la cuenta del actor autenticado
    const { data: acc } = await supabase
        .from('bank_accounts')
        .select('id')
        .eq('owner_user_id', actor.id)
        .single();

    if (!acc) {
        return c.json({ success: false, error: 'Cuenta bancaria no encontrada' }, 404);
    }

    // 2. Paginación opcional (?limit=50&offset=0)
    const rawLimit = Number(c.req.query('limit') ?? 50);
    const rawOffset = Number(c.req.query('offset') ?? 0);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    // 3. Consulta filtrada SOLO por la cuenta del actor (obligatorio con service_role)
    const { data, error } = await supabase
        .from('bank_transactions')
        .select('id, account_id, tx_type, amount, balance_after, description, reference_id, created_at')
        .eq('account_id', acc.id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (error) {
        return c.json({ success: false, error: error.message }, 500);
    }

    // 4. Derivar dirección. Whitelist de tipos que RESTAN saldo.
    //    Cualquier otro tipo se considera CREDIT.
    const DEBIT_TYPES = new Set<string>([
        'PURCHASE_PAYMENT',
        'SUBSCRIPTION_FEE',
        'TRANSFER_OUT',
        'WITHDRAWAL',
        'ESCROW_HOLD',
    ]);

    const mapped = (data ?? []).map((tx) => ({
        id: tx.id,
        tx_type: tx.tx_type,
        direction: DEBIT_TYPES.has(tx.tx_type as string) ? 'DEBIT' : 'CREDIT',
        amount: Number(tx.amount),
        balance_after: Number(tx.balance_after),
        description: tx.description,
        reference_id: tx.reference_id,
        created_at: tx.created_at,
    }));

    return c.json({ success: true, data: mapped });
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

// ─── POST /transfer-direct (Transferencias entre cuentas mediante QR fijo) ──
bankRoutes.post(
  '/transfer-direct',
  zValidator(
    'json',
    z.object({
      target_account_id: z.string().uuid(),
      amount: z.number().positive(),
      pin: z.string().min(4).max(6),
    })
  ),
  async (c) => {
    const actor = c.get('actor');
    const { target_account_id, amount, pin } = c.req.valid('json');
    const supabase = createSupabaseAdmin(c.env);

    // 1. Obtener la cuenta origen del actor autenticado
    const { data: sourceAcc } = await supabase
      .from('bank_accounts')
      .select('*')
      .eq('owner_user_id', actor.id)
      .single();

    if (!sourceAcc) {
      return c.json({ success: false, error: 'No tienes una cuenta bancaria asignada' }, 404);
    }

    // 2. Verificar cuenta destino
    const { data: targetAcc } = await supabase
      .from('bank_accounts')
      .select('*')
      .eq('id', target_account_id)
      .single();

    if (!targetAcc) {
      return c.json({ success: false, error: 'Cuenta de destino no encontrada' }, 404);
    }

    if (sourceAcc.id === targetAcc.id) {
      return c.json({ success: false, error: 'No puedes transferir a tu propia cuenta' }, 400);
    }

    if (sourceAcc.balance < amount) {
      return c.json({ success: false, error: 'Fondos insuficientes' }, 400);
    }

    // 3. Ejecutar transferencia atómica: debitar origen y acreditar destino
    const newSourceBalance = Number(sourceAcc.balance) - amount;
    const newTargetBalance = Number(targetAcc.balance) + amount;

    await supabase
      .from('bank_accounts')
      .update({ balance: newSourceBalance })
      .eq('id', sourceAcc.id);

    await supabase
      .from('bank_accounts')
      .update({ balance: newTargetBalance })
      .eq('id', targetAcc.id);

    // Registrar en Ledger
    await supabase.from('bank_transactions').insert([
      {
        account_id: sourceAcc.id,
        tx_type: 'PURCHASE_PAYMENT',
        amount,
        balance_after: newSourceBalance,
        description: `Transferencia Simple QR a cuenta ${targetAcc.account_number}`,
      },
      {
        account_id: targetAcc.id,
        tx_type: 'DEPOSIT',
        amount,
        balance_after: newTargetBalance,
        description: `Transferencia Simple QR recibida de ${sourceAcc.account_number}`,
      },
    ]);

    return c.json({
      success: true,
      data: {
        amount,
        balance_remaining: newSourceBalance,
        target_account: targetAcc.account_number,
      },
    });
  }
);

export default bankRoutes;