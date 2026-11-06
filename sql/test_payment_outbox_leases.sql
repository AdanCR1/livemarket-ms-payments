-- Solo base aislada VACÍA. Nunca ejecutar en la base con eventos del negocio.
begin;
do $$
declare
  event public.payment_outbox;
  reclaimed public.payment_outbox;
begin
  if exists(select 1 from public.payment_outbox) then
    raise exception 'TEST_REQUIRES_EMPTY_OUTBOX';
  end if;
  insert into public.payment_outbox(event_type,destination,aggregate_id,payload,status,attempts,claimed_at)
    values('FIXTURE','MS4',gen_random_uuid(),'{}','PROCESSING',0,now()-interval '1 hour');
  select * into event from public.ms6_claim_payment_events_v2(1);
  if event.claim_token is null or event.attempts<>1 then raise exception 'CLAIM_FAILED'; end if;
  if exists(select 1 from public.ms6_claim_payment_events_v2(1)) then raise exception 'DUPLICATE_ACTIVE_CLAIM'; end if;
  update public.payment_outbox set claimed_at=now()-interval '1 hour' where id=event.id;
  select * into reclaimed from public.ms6_claim_payment_events_v2(1);
  if reclaimed.claim_token=event.claim_token or reclaimed.attempts<>2 then raise exception 'RECLAIM_FAILED'; end if;
  if public.ms6_ack_payment_event_v2(event.id,event.claim_token,true) then raise exception 'STALE_ACK_ACCEPTED'; end if;
  if not public.ms6_ack_payment_event_v2(reclaimed.id,reclaimed.claim_token,false,'MS4_HTTP_503') then
    raise exception 'FAILURE_ACK_REJECTED';
  end if;
  if exists(select 1 from public.ms6_claim_payment_events_v2(1)) then raise exception 'BACKOFF_IGNORED'; end if;
  update public.payment_outbox set next_retry_at=now()-interval '1 second' where id=event.id;
  select * into reclaimed from public.ms6_claim_payment_events_v2(1);
  if not public.ms6_ack_payment_event_v2(reclaimed.id,reclaimed.claim_token,true) then raise exception 'SUCCESS_ACK_REJECTED'; end if;
  if public.ms6_ack_payment_event_v2(reclaimed.id,reclaimed.claim_token,true) then raise exception 'DUPLICATE_ACK_ACCEPTED'; end if;
  if exists(select 1 from public.ms6_claim_payment_events_v2(1)) then raise exception 'SENT_RECLAIMED'; end if;
end;
$$;
rollback;
