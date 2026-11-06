-- MS6: stop cron/consumers before rollback. Installed v2 is preserved.
begin;
do $$ begin
 if exists(select 1 from public.payment_outbox where claim_token is not null and status='PROCESSING') then raise exception 'ACTIVE_LEASES';end if;
end $$;
drop function public.ms6_claim_order_payment_events_v3(integer,uuid,uuid);
drop table public.ms6_order_dispatch_policy;
commit;
