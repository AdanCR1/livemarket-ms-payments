-- Detener primero los invocadores y esperar/resolver leases de forma controlada.
begin;
do $$
begin
  if exists(select 1 from public.payment_outbox where claim_token is not null) then
    raise exception 'ACTIVE_LEASES_PREVENT_ROLLBACK';
  end if;
end;
$$;
drop function public.ms6_ack_payment_event_v2(uuid,uuid,boolean,text);
drop function public.ms6_claim_payment_events_v2(integer);
-- Conservar claim_token evita una eliminación innecesaria y mantiene diagnóstico.
commit;
