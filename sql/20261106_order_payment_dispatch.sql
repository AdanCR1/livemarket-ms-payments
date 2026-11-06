-- MS6. Depends on installed v2 leases. Does not claim/send/update any existing event.
begin;
create table public.ms6_order_dispatch_policy(singleton boolean primary key default true check(singleton),automatic_since timestamptz not null default clock_timestamp());
insert into public.ms6_order_dispatch_policy default values;
alter table public.ms6_order_dispatch_policy enable row level security;
revoke all on public.ms6_order_dispatch_policy from public,anon,authenticated;
create function public.ms6_claim_order_payment_events_v3(p_limit integer default 5,p_payment_id uuid default null,p_outbox_id uuid default null)
returns setof public.payment_outbox language plpgsql security definer set search_path='' as $$
begin
 if p_limit is null or p_limit not between 1 and 20 or (p_payment_id is not null and p_outbox_id is not null) then raise exception 'INVALID_CLAIM';end if;
 return query with ready as (
  select o.id from public.payment_outbox o
  where o.destination='MS4' and o.event_type='PAYMENT_SUCCEEDED'
   and (p_payment_id is null or o.aggregate_id=p_payment_id)
   and (p_outbox_id is null or o.id=p_outbox_id)
   and (p_payment_id is not null or p_outbox_id is not null or o.created_at >= (select automatic_since from public.ms6_order_dispatch_policy where singleton))
   and ((o.status in ('PENDING','FAILED') and o.next_retry_at<=clock_timestamp()) or
        (o.status='PROCESSING' and coalesce(o.claimed_at,o.created_at)<clock_timestamp()-interval '2 minutes'))
  order by o.created_at,o.id for update skip locked limit p_limit
 ) update public.payment_outbox o set status='PROCESSING',claimed_at=clock_timestamp(),claim_token=gen_random_uuid(),attempts=o.attempts+1
 from ready where o.id=ready.id returning o.*;
end;$$;
revoke all on function public.ms6_claim_order_payment_events_v3(integer,uuid,uuid) from public,anon,authenticated;
grant execute on function public.ms6_claim_order_payment_events_v3(integer,uuid,uuid) to service_role;
commit;
