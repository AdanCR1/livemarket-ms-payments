-- Aplicar primero en DEV. No ejecuta ni reenvía eventos.
begin;
alter table public.payment_outbox add column claim_token uuid;
create function public.ms6_claim_payment_events_v2(p_limit integer default 5)
returns setof public.payment_outbox language plpgsql set search_path='' as $$
begin
  if p_limit is null or p_limit not between 1 and 20 then
    raise exception 'INVALID_LIMIT' using errcode='22023';
  end if;
  return query
    with ready as (
      select id from public.payment_outbox
      where ((status in ('PENDING','FAILED') and next_retry_at<=clock_timestamp())
        or (status='PROCESSING' and
          coalesce(claimed_at,created_at)<clock_timestamp()-interval '2 minutes'))
      order by created_at,id for update skip locked limit p_limit
    )
    update public.payment_outbox o
    set status='PROCESSING',claimed_at=clock_timestamp(),claim_token=gen_random_uuid(),attempts=o.attempts+1
    from ready where o.id=ready.id returning o.*;
end;
$$;
create function public.ms6_ack_payment_event_v2(p_event_id uuid,p_claim_token uuid,p_success boolean,p_error text default '')
returns boolean language plpgsql set search_path='' as $$
begin
  if p_success is null then raise exception 'INVALID_ACK' using errcode='22023'; end if;
  if p_success then
    update public.payment_outbox set status='SENT',sent_at=clock_timestamp(),
      claimed_at=null,claim_token=null,last_error=null
    where id=p_event_id and status='PROCESSING' and claim_token=p_claim_token;
  else
    update public.payment_outbox set status='FAILED',claimed_at=null,claim_token=null,
      last_error=left(coalesce(p_error,''),200),
      next_retry_at=clock_timestamp()+make_interval(secs=>least(3600,power(2,least(attempts,10))::integer))
    where id=p_event_id and status='PROCESSING' and claim_token=p_claim_token;
  end if;
  return found;
end;
$$;
revoke all on function public.ms6_claim_payment_events_v2(integer),
  public.ms6_ack_payment_event_v2(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.ms6_claim_payment_events_v2(integer),
  public.ms6_ack_payment_event_v2(uuid,uuid,boolean,text) to service_role;
commit;
