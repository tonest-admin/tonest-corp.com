-- No real identities or production data.
do $$ declare b uuid; r uuid; result jsonb; n integer; begin
insert into public.meta_realtime_batch(schedule_date,meta_work_date,camp_code,camp_name,wave,expected_rounds)
values('2020-01-01','2020-01-02','TEST','TEST','WAVE1',2) returning id into b;
if (select expected_rounds from public.meta_realtime_batch where id=b)<>3 then raise exception 'night policy failed'; end if;
insert into public.meta_realtime_current(batch_id,schedule_date,meta_work_date,camp_code,camp_name,wave,meta_worker_key,
  current_round,delivery_completed,delivery_total,scan_started_at,work_completed_at,round2_delivery_started_at)
values(b,'2020-01-01','2020-01-02','TEST','TEST','WAVE1','test',2,10,10,'2020-01-01 20:00','2020-01-02 01:00','2020-01-01 23:00') returning id into r;
update public.meta_realtime_batch set work_completed_at='2020-01-02 01:00' where id=b;
begin
  perform public.meta_finalize_realtime_batch(b);
  raise exception 'TEST: premature finalization was not blocked';
exception when others then
  if sqlerrm <> 'META final round is not complete' then raise; end if;
end;
update public.meta_realtime_current set current_round=3,round3_delivery_started_at='2020-01-02 02:00',
 round3_completed_at='2020-01-02 03:00',work_completed_at='2020-01-02 03:00',all_done=true where id=r;
update public.meta_realtime_batch set work_completed_at='2020-01-02 03:00' where id=b;
insert into public.meta_realtime_fresh_current(batch_id,schedule_date,meta_work_date,camp_code,camp_name,wave,meta_worker_key,
 delivery_total,delivery_completed) values(b,'2020-01-01','2020-01-02','TEST','TEST','WAVE2','test',7,7);
result=public.meta_finalize_realtime_batch(b);
if not (result->>'ok')::boolean then raise exception 'finalize failed'; end if;
if exists(select 1 from public.meta_realtime_current where batch_id=b) then raise exception 'current not moved'; end if;
if not exists(select 1 from public.meta_realtime_final where batch_id=b and actual_rounds=3 and expected_rounds=3
 and round3_completed_at='2020-01-02 03:00' and fresh_delivery_total=7) then raise exception 'final snapshot fields lost'; end if;
result=public.meta_finalize_realtime_batch(b);
if not (result->>'already_finalized')::boolean then raise exception 'finalize not idempotent'; end if;
if has_table_privilege('authenticated','public.meta_backend_state','select') then raise exception 'session table leaked'; end if;
if has_function_privilege('anon','public.meta_finalize_realtime_batch(uuid)','execute') then raise exception 'finalizer public'; end if;
end $$;
