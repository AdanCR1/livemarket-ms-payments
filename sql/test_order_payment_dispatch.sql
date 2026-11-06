-- MS6 fixture database only. No payment execution RPC or external effects.
begin;
do $$
declare old_id uuid:=gen_random_uuid();new_id uuid:=gen_random_uuid();subscription_id uuid:=gen_random_uuid();pid uuid:=gen_random_uuid();e record;t uuid;cnt int;
begin
 insert into public.payment_outbox(id,event_type,destination,aggregate_id,payload,status,created_at)
 values(old_id,'PAYMENT_SUCCEEDED','MS4',pid,'{}','PENDING',now()-interval '1 day'),
       (new_id,'PAYMENT_SUCCEEDED','MS4',gen_random_uuid(),'{}','PENDING',clock_timestamp()+interval '1 second'),
       (subscription_id,'SUBSCRIPTION_CHANGED','MS1',gen_random_uuid(),'{}','PENDING',clock_timestamp()+interval '1 second');
 select count(*) into cnt from public.ms6_claim_order_payment_events_v3();
 if cnt<>1 or not exists(select 1 from public.payment_outbox where id=new_id and status='PROCESSING') then raise exception 'AUTOMATIC_FILTER_FAILED';end if;
 if exists(select 1 from public.payment_outbox where id in(old_id,subscription_id) and status<>'PENDING') then raise exception 'HISTORICAL_OR_SUBSCRIPTION_TOUCHED';end if;
 select * into e from public.ms6_claim_order_payment_events_v3(5,pid,null);
 if e.id is distinct from old_id or e.attempts<>1 then raise exception 'SPECIFIC_CLAIM_FAILED';end if;
 select count(*) into cnt from public.ms6_claim_order_payment_events_v3(5,pid,null);
 if cnt<>0 then raise exception 'DOUBLE_CLAIM';end if;
 t:=e.claim_token;
 update public.payment_outbox set claimed_at=clock_timestamp()-interval '3 minutes' where id=old_id;
 select * into e from public.ms6_claim_order_payment_events_v3(5,null,old_id);
 if e.attempts<>2 or e.claim_token=t then raise exception 'LEASE_RECOVERY_FAILED';end if;
 if public.ms6_ack_payment_event_v2(old_id,t,true,'') then raise exception 'STALE_ACK_ACCEPTED';end if;
 if not public.ms6_ack_payment_event_v2(old_id,e.claim_token,false,'MS4_DOWN') then raise exception 'FAILED_ACK';end if;
 if not exists(select 1 from public.payment_outbox where id=old_id and status='FAILED' and next_retry_at>clock_timestamp()) then raise exception 'BACKOFF_FAILED';end if;
 update public.payment_outbox set next_retry_at=clock_timestamp()-interval '1 second' where id=old_id;
 select * into e from public.ms6_claim_order_payment_events_v3(5,null,old_id);
 if not public.ms6_ack_payment_event_v2(old_id,e.claim_token,true,'') then raise exception 'SUCCESS_ACK_FAILED';end if;
 if public.ms6_ack_payment_event_v2(old_id,e.claim_token,true,'') then raise exception 'REPEATED_ACK_ACCEPTED';end if;
 select count(*) into cnt from public.ms6_claim_order_payment_events_v3(5,null,old_id);
 if cnt<>0 then raise exception 'SENT_RECLAIMED';end if;
end;$$;
rollback;
