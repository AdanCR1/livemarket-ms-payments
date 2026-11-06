import {readFile} from 'node:fs/promises';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const pg=new PGlite();
await pg.exec(`create role anon;create role authenticated;create role service_role;
create type public.outbox_status as enum('PENDING','PROCESSING','SENT','FAILED');
create table public.payment_outbox(id uuid primary key default gen_random_uuid(),event_type text,destination text,aggregate_id uuid,payload jsonb,status public.outbox_status default 'PENDING',attempts int default 0,next_retry_at timestamptz default now(),claimed_at timestamptz,sent_at timestamptz,last_error text,created_at timestamptz default now());`);
const sql=async p=>pg.exec(await readFile(new URL(p,import.meta.url),'utf8'));
// v2 is installed ONCE in the ephemeral fixture, never applied remotely.
await sql('../sql/20261105_payment_outbox_leases.sql');
await sql('../sql/20261106_order_payment_dispatch.sql');
await sql('../sql/test_order_payment_dispatch.sql');
if((await pg.query('select count(*)::int n from payment_outbox')).rows[0].n!==0)throw Error('Fixture rollback failed');
await sql('../sql/20261106_order_payment_dispatch.rollback.sql');
await pg.close();
console.log('MS6 PostgreSQL: selective claim, historical/subscription isolation, leases, attempts, stale/repeated ACK, recovery, backoff, SENT, fixture/migration rollback PASS');
