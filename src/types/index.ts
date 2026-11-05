export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  JWT_SECRET: string;
  PAYMENT_QR_SECRET: string;
  PAYMENTS_INTERNAL_KEY: string;
  ESCROW_AUTO_SETTLEMENT_VERIFIED?: string;
  PLATFORM_BANK_ACCOUNT_ID?: string;
  SUBSCRIPTION_PRO_BOB?: string;
  PRO_TREASURY_SQL_VERIFIED?: string;
  ORDER_ESCROW_ATOMIC_VERIFIED?: string;
  MS4_INTERNAL_KEY: string;
  MS4_URL: string;
  MS1_URL: string;
}

export type Actor = {
  id: string;
  role: 'B2C' | 'B2B' | 'DRIVER';
  storeId?: string;
};

export interface AppContext {
  Bindings: Env;
  Variables: {
    actor: Actor;
  };
}
