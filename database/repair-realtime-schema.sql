-- TO:NEST realtime repair. Reviewed against the legacy SQL reference, NOT the live TO:NEST DB.
-- Apply only in vgwyhdqofjzqfajtolaj after taking a database backup and reviewing audit-realtime-schema.sql.
-- Transactional and rerunnable. Type mismatch, duplicate keys or broken FKs abort without deleting data.
-- Existing finalized/history records are retained. Missing third-round times are never fabricated.
-- After successful apply AND audit, explicitly enable the collector using the deployment workflow.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
do $$ begin
  if to_regclass('public.profiles') is null or to_regclass('public.tonest_info') is null then
    raise exception 'TO:NEST profiles and tonest_info must exist. Stop: do not run on MAROOWELL.';
  end if;
end $$;


create extension if not exists pgcrypto;

-- ============================================================================
-- 0. Common helpers
-- ============================================================================

create or replace function public.tn_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- 1. TO:NEST schedule
--    MAROOWELL public.maroowell_schedule 20개 컬럼 구조를 그대로 유지하고
--    마지막에 TO:NEST 전용 driver_pk 만 추가한다.
-- ============================================================================

create table if not exists public.tonest_schedule (
  id uuid primary key default gen_random_uuid(),
  schedule_date date not null,
  iso_year integer,
  iso_week integer,
  week_label text,
  camp text not null,
  route_label text not null,
  driver_name text,
  memo text,
  row_order integer not null default 0,
  cell_color text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  wave text not null default 'WAVE2',
  driver_display_name text,
  driver_owner_name text,
  driver_export_name text,
  driver_coupang_id text,
  driver_account_type text,

  -- TO:NEST 기사 마스터 연결용. MAROOWELL 원본 20개 컬럼 뒤에만 추가.
  driver_pk bigint,

  constraint tonest_schedule_wave_check
    check (wave in ('WAVE1','WAVE2'))
);

-- Upgrade existing tables, not only new installations.
alter table public.tonest_schedule add column if not exists id uuid primary key default gen_random_uuid();
alter table public.tonest_schedule add column if not exists schedule_date date not null;
alter table public.tonest_schedule add column if not exists iso_year integer;
alter table public.tonest_schedule add column if not exists iso_week integer;
alter table public.tonest_schedule add column if not exists week_label text;
alter table public.tonest_schedule add column if not exists camp text not null;
alter table public.tonest_schedule add column if not exists route_label text not null;
alter table public.tonest_schedule add column if not exists driver_name text;
alter table public.tonest_schedule add column if not exists memo text;
alter table public.tonest_schedule add column if not exists row_order integer not null default 0;
alter table public.tonest_schedule add column if not exists cell_color text;
alter table public.tonest_schedule add column if not exists is_active boolean not null default true;
alter table public.tonest_schedule add column if not exists created_at timestamptz not null default now();
alter table public.tonest_schedule add column if not exists updated_at timestamptz not null default now();
alter table public.tonest_schedule add column if not exists wave text not null default 'WAVE2';
alter table public.tonest_schedule add column if not exists driver_display_name text;
alter table public.tonest_schedule add column if not exists driver_owner_name text;
alter table public.tonest_schedule add column if not exists driver_export_name text;
alter table public.tonest_schedule add column if not exists driver_coupang_id text;
alter table public.tonest_schedule add column if not exists driver_account_type text;
alter table public.tonest_schedule add column if not exists driver_pk bigint;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.tonest_schedule'::regclass and conname='tonest_schedule_wave_check') then alter table public.tonest_schedule add constraint tonest_schedule_wave_check
    check (wave in ('WAVE1','WAVE2')); end if; end $$;


create unique index if not exists tonest_schedule_unique_day_wave_route
  on public.tonest_schedule(schedule_date,camp,wave,route_label);
create index if not exists idx_tonest_schedule_active
  on public.tonest_schedule(is_active);
create index if not exists idx_tonest_schedule_camp
  on public.tonest_schedule(camp);
create index if not exists idx_tonest_schedule_date
  on public.tonest_schedule(schedule_date);
create index if not exists idx_tonest_schedule_date_camp_wave
  on public.tonest_schedule(schedule_date,camp,wave);
create index if not exists idx_tonest_schedule_driver_coupang_id
  on public.tonest_schedule(driver_coupang_id);
create index if not exists idx_tonest_schedule_driver_export_name
  on public.tonest_schedule(driver_export_name);
create index if not exists idx_tonest_schedule_driver_pk
  on public.tonest_schedule(driver_pk);
create index if not exists idx_tonest_schedule_route_label
  on public.tonest_schedule(route_label);
create index if not exists idx_tonest_schedule_wave
  on public.tonest_schedule(wave);
create index if not exists idx_tonest_schedule_week
  on public.tonest_schedule(iso_year,iso_week);
create index if not exists idx_tonest_schedule_week_wave
  on public.tonest_schedule(iso_year,iso_week,camp,wave);

create or replace function public.tn_schedule_fill_derived()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.schedule_date is not null then
    new.iso_year := extract(isoyear from new.schedule_date)::integer;
    new.iso_week := extract(week from new.schedule_date)::integer;
    new.week_label := new.iso_year::text || '-W' || lpad(new.iso_week::text,2,'0');
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tonest_schedule_fill_derived_trg on public.tonest_schedule;
create trigger tonest_schedule_fill_derived_trg
before insert or update on public.tonest_schedule
for each row execute function public.tn_schedule_fill_derived();

-- tonest_info.pk_id 가 bigint 인 경우에만 안전하게 FK 추가
DO $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema='public'
      and table_name='tonest_info'
      and column_name='pk_id'
      and udt_name='int8'
  ) and not exists (
    select 1 from pg_constraint where conname='tonest_schedule_driver_pk_fkey'
  ) then
    alter table public.tonest_schedule
      add constraint tonest_schedule_driver_pk_fkey
      foreign key(driver_pk) references public.tonest_info(pk_id)
      on update cascade on delete set null;
  end if;
end $$;

-- ============================================================================
-- 2. META session / collector state
--    ID/PW는 Cloudflare Worker Secret 에만 저장한다.
--    DB에는 로그인 후 FLY 세션 쿠키만 보관한다.
-- ============================================================================

create table if not exists public.meta_backend_state (
  id smallint primary key default 1,
  cookie_bundle text,
  status text not null default 'empty',
  updated_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_http_status integer,
  last_error text,
  collector_paused boolean not null default false,
  collector_paused_at timestamptz,
  collector_paused_by uuid,
  constraint meta_backend_state_id_check check (id=1),
  constraint meta_backend_state_status_check
    check (status in ('empty','active','expired','error'))
);

-- Upgrade existing tables, not only new installations.
alter table public.meta_backend_state add column if not exists id smallint primary key default 1;
alter table public.meta_backend_state add column if not exists cookie_bundle text;
alter table public.meta_backend_state add column if not exists status text not null default 'empty';
alter table public.meta_backend_state add column if not exists updated_at timestamptz not null default now();
alter table public.meta_backend_state add column if not exists last_success_at timestamptz;
alter table public.meta_backend_state add column if not exists last_http_status integer;
alter table public.meta_backend_state add column if not exists last_error text;
alter table public.meta_backend_state add column if not exists collector_paused boolean not null default false;
alter table public.meta_backend_state add column if not exists collector_paused_at timestamptz;
alter table public.meta_backend_state add column if not exists collector_paused_by uuid;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_backend_state'::regclass and conname='meta_backend_state_id_check') then alter table public.meta_backend_state add constraint meta_backend_state_id_check check (id=1); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_backend_state'::regclass and conname='meta_backend_state_status_check') then alter table public.meta_backend_state add constraint meta_backend_state_status_check
    check (status in ('empty','active','expired','error')); end if; end $$;


insert into public.meta_backend_state(id)
values(1)
on conflict(id) do nothing;

-- ============================================================================
-- 3. Lifecycle helpers
-- ============================================================================

create or replace function public.meta_realtime_visible_until(
  p_schedule_date date,
  p_wave text,
  p_work_completed_at timestamp without time zone
)
returns timestamp without time zone
language sql
immutable
strict
set search_path=''
as $$
  select case
    when upper(p_wave)='WAVE2' then
      least(
        (p_schedule_date + 1)::timestamp,
        greatest(
          p_schedule_date + time '21:00',
          p_work_completed_at + interval '1 hour'
        )
      )
    when upper(p_wave)='WAVE1' then
      least(
        (p_schedule_date + 1) + time '12:00',
        p_work_completed_at + interval '1 hour'
      )
    else p_work_completed_at + interval '1 hour'
  end
$$;

create or replace function public.meta_realtime_metrics_close_at(
  p_schedule_date date,
  p_wave text
)
returns timestamp without time zone
language sql
immutable
strict
set search_path=''
as $$
  select case
    when upper(p_wave)='WAVE2' then p_schedule_date + time '23:59'
    when upper(p_wave)='WAVE1' then (p_schedule_date + 1) + time '11:59'
    else p_schedule_date + time '23:59'
  end
$$;

-- ============================================================================
-- 4. Realtime batch
-- ============================================================================

create table if not exists public.meta_realtime_batch (
  id uuid primary key default gen_random_uuid(),
  schedule_date date not null,
  meta_work_date date not null,
  camp_code text not null,
  camp_name text,
  wave text not null,
  status text not null default 'collecting',
  collect_from timestamp without time zone,
  collect_until timestamp without time zone,
  started_at timestamp without time zone not null default timezone('Asia/Seoul',now()),
  last_polled_at timestamp without time zone,
  completion_candidate_at timestamp without time zone,
  finalized_at timestamp without time zone,
  worker_count integer not null default 0,
  completed_worker_count integer not null default 0,
  stable_complete_poll_count smallint not null default 0,
  poll_interval_seconds integer not null default 60,
  next_poll_at timestamp without time zone,
  last_error text,
  created_at timestamp without time zone not null default timezone('Asia/Seoul',now()),
  updated_at timestamp without time zone not null default timezone('Asia/Seoul',now()),
  meta_camp_codes text[] not null default array[]::text[],
  fresh_miss text not null default 'N',
  dawn_miss text not null default 'N',
  expected_rounds smallint not null default 2,
  completion_method text,
  completion_detected_at timestamp without time zone,
  collector_lock_token uuid,
  collector_lock_until timestamptz,
  work_completed_at timestamp without time zone,
  metrics_status text not null default 'collecting',
  metrics_closed_at timestamp without time zone,
  visible_until timestamp without time zone generated always as (
    public.meta_realtime_visible_until(schedule_date,wave,work_completed_at)
  ) stored,
  metrics_close_at timestamp without time zone generated always as (
    public.meta_realtime_metrics_close_at(schedule_date,wave)
  ) stored,
  constraint meta_realtime_batch_wave_check check(wave in ('WAVE1','WAVE2')),
  constraint meta_realtime_batch_status_check check(status in ('collecting','completion_candidate','finalized','overdue','error','paused')),
  constraint meta_realtime_batch_worker_count_check check(worker_count>=0),
  constraint meta_realtime_batch_completed_worker_count_check check(completed_worker_count>=0),
  constraint meta_realtime_batch_stable_complete_poll_count_check check(stable_complete_poll_count>=0),
  constraint meta_realtime_batch_poll_interval_seconds_check check(poll_interval_seconds>=60),
  constraint meta_realtime_batch_fresh_miss_check check(fresh_miss in ('Y','N')),
  constraint meta_realtime_batch_dawn_miss_check check(dawn_miss in ('Y','N')),
  constraint meta_realtime_batch_expected_rounds_check check(expected_rounds between 1 and 3),
  constraint meta_realtime_batch_metrics_status_check check(metrics_status in ('collecting','closed')),
  constraint meta_realtime_batch_schedule_date_camp_code_wave_key unique(schedule_date,camp_code,wave)
);

-- Upgrade existing tables, not only new installations.
alter table public.meta_realtime_batch add column if not exists id uuid primary key default gen_random_uuid();
alter table public.meta_realtime_batch add column if not exists schedule_date date not null;
alter table public.meta_realtime_batch add column if not exists meta_work_date date not null;
alter table public.meta_realtime_batch add column if not exists camp_code text not null;
alter table public.meta_realtime_batch add column if not exists camp_name text;
alter table public.meta_realtime_batch add column if not exists wave text not null;
alter table public.meta_realtime_batch add column if not exists status text not null default 'collecting';
alter table public.meta_realtime_batch add column if not exists collect_from timestamp without time zone;
alter table public.meta_realtime_batch add column if not exists collect_until timestamp without time zone;
alter table public.meta_realtime_batch add column if not exists started_at timestamp without time zone not null default timezone('Asia/Seoul',now());
alter table public.meta_realtime_batch add column if not exists last_polled_at timestamp without time zone;
alter table public.meta_realtime_batch add column if not exists completion_candidate_at timestamp without time zone;
alter table public.meta_realtime_batch add column if not exists finalized_at timestamp without time zone;
alter table public.meta_realtime_batch add column if not exists worker_count integer not null default 0;
alter table public.meta_realtime_batch add column if not exists completed_worker_count integer not null default 0;
alter table public.meta_realtime_batch add column if not exists stable_complete_poll_count smallint not null default 0;
alter table public.meta_realtime_batch add column if not exists poll_interval_seconds integer not null default 60;
alter table public.meta_realtime_batch add column if not exists next_poll_at timestamp without time zone;
alter table public.meta_realtime_batch add column if not exists last_error text;
alter table public.meta_realtime_batch add column if not exists created_at timestamp without time zone not null default timezone('Asia/Seoul',now());
alter table public.meta_realtime_batch add column if not exists updated_at timestamp without time zone not null default timezone('Asia/Seoul',now());
alter table public.meta_realtime_batch add column if not exists meta_camp_codes text[] not null default array[]::text[];
alter table public.meta_realtime_batch add column if not exists fresh_miss text not null default 'N';
alter table public.meta_realtime_batch add column if not exists dawn_miss text not null default 'N';
alter table public.meta_realtime_batch add column if not exists expected_rounds smallint not null default 2;
alter table public.meta_realtime_batch add column if not exists completion_method text;
alter table public.meta_realtime_batch add column if not exists completion_detected_at timestamp without time zone;
alter table public.meta_realtime_batch add column if not exists collector_lock_token uuid;
alter table public.meta_realtime_batch add column if not exists collector_lock_until timestamptz;
alter table public.meta_realtime_batch add column if not exists work_completed_at timestamp without time zone;
alter table public.meta_realtime_batch add column if not exists metrics_status text not null default 'collecting';
alter table public.meta_realtime_batch add column if not exists metrics_closed_at timestamp without time zone;
alter table public.meta_realtime_batch add column if not exists visible_until timestamp without time zone generated always as (
    public.meta_realtime_visible_until(schedule_date,wave,work_completed_at)
  ) stored;
alter table public.meta_realtime_batch add column if not exists metrics_close_at timestamp without time zone generated always as (
    public.meta_realtime_metrics_close_at(schedule_date,wave)
  ) stored;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_batch'::regclass and conname='meta_realtime_batch_wave_check') then alter table public.meta_realtime_batch add constraint meta_realtime_batch_wave_check check(wave in ('WAVE1','WAVE2')); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_batch'::regclass and conname='meta_realtime_batch_status_check') then alter table public.meta_realtime_batch add constraint meta_realtime_batch_status_check check(status in ('collecting','completion_candidate','finalized','overdue','error','paused')); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_batch'::regclass and conname='meta_realtime_batch_worker_count_check') then alter table public.meta_realtime_batch add constraint meta_realtime_batch_worker_count_check check(worker_count>=0); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_batch'::regclass and conname='meta_realtime_batch_completed_worker_count_check') then alter table public.meta_realtime_batch add constraint meta_realtime_batch_completed_worker_count_check check(completed_worker_count>=0); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_batch'::regclass and conname='meta_realtime_batch_stable_complete_poll_count_check') then alter table public.meta_realtime_batch add constraint meta_realtime_batch_stable_complete_poll_count_check check(stable_complete_poll_count>=0); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_batch'::regclass and conname='meta_realtime_batch_poll_interval_seconds_check') then alter table public.meta_realtime_batch add constraint meta_realtime_batch_poll_interval_seconds_check check(poll_interval_seconds>=60); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_batch'::regclass and conname='meta_realtime_batch_fresh_miss_check') then alter table public.meta_realtime_batch add constraint meta_realtime_batch_fresh_miss_check check(fresh_miss in ('Y','N')); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_batch'::regclass and conname='meta_realtime_batch_dawn_miss_check') then alter table public.meta_realtime_batch add constraint meta_realtime_batch_dawn_miss_check check(dawn_miss in ('Y','N')); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_batch'::regclass and conname='meta_realtime_batch_expected_rounds_check') then alter table public.meta_realtime_batch add constraint meta_realtime_batch_expected_rounds_check check(expected_rounds between 1 and 3); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_batch'::regclass and conname='meta_realtime_batch_metrics_status_check') then alter table public.meta_realtime_batch add constraint meta_realtime_batch_metrics_status_check check(metrics_status in ('collecting','closed')); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_batch'::regclass and conname='meta_realtime_batch_schedule_date_camp_code_wave_key') then alter table public.meta_realtime_batch add constraint meta_realtime_batch_schedule_date_camp_code_wave_key unique(schedule_date,camp_code,wave); end if; end $$;


create index if not exists meta_realtime_batch_status_idx
  on public.meta_realtime_batch(status,next_poll_at);
create index if not exists idx_meta_realtime_batch_lifecycle
  on public.meta_realtime_batch(status,metrics_status,metrics_close_at);
create index if not exists idx_meta_realtime_batch_visible_until
  on public.meta_realtime_batch(visible_until)
  where work_completed_at is not null;

-- ============================================================================
-- 5. Current worker state
-- ============================================================================

create table if not exists public.meta_realtime_current (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.meta_realtime_batch(id) on delete cascade,
  schedule_date date not null,
  meta_work_date date not null,
  camp_code text not null,
  camp_name text,
  wave text not null,
  coupang_id text,
  driver_name text,
  driver_account_type text,
  scheduled_routes text[] not null default array[]::text[],
  actual_routes text[] not null default array[]::text[],
  extra_routes text[],
  delivery_assigned integer not null default 0,
  delivery_scanned integer not null default 0,
  delivery_completed integer not null default 0,
  delivery_impossible integer not null default 0,
  delivery_pdd_miss integer not null default 0,
  delivery_total integer not null default 0,
  delivery_complete_rate numeric,
  return_pending integer default 0,
  return_collected integer default 0,
  return_uncollected_raw integer default 0,
  return_absent_raw integer default 0,
  return_uncollected integer,
  return_total integer default 0,
  return_attempt_rate numeric,
  return_collection_rate numeric,
  freshbag_pending integer not null default 0,
  freshbag_collected integer not null default 0,
  freshbag_uncollected integer not null default 0,
  freshbag_total integer not null default 0,
  freshbag_attempt_rate numeric,
  freshbag_collection_rate numeric,
  scan_started_at timestamp without time zone,
  delivery_started_at timestamp without time zone,
  delivery_completed_at timestamp without time zone,
  all_completed_at timestamp without time zone,
  first_seen_at timestamp without time zone not null default timezone('Asia/Seoul',now()),
  last_seen_at timestamp without time zone not null default timezone('Asia/Seoul',now()),
  delivery_done boolean not null default false,
  return_done boolean,
  freshbag_done boolean not null default false,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamp without time zone not null default timezone('Asia/Seoul',now()),
  updated_at timestamp without time zone not null default timezone('Asia/Seoul',now()),
  fresh_delivery_assigned integer not null default 0,
  fresh_delivery_scanned integer not null default 0,
  fresh_delivery_completed integer not null default 0,
  fresh_delivery_impossible integer not null default 0,
  fresh_delivery_pdd_miss integer not null default 0,
  fresh_delivery_total integer not null default 0,
  fresh_delivery_complete_rate numeric,
  meta_worker_key text not null,
  source_camp_code text,
  all_done boolean,
  share boolean not null default false,
  fresh_miss text not null default 'N',
  dawn_miss text not null default 'N',
  driver_pk bigint,
  current_round smallint not null default 1,
  expected_rounds smallint not null default 2,
  last_progress_at timestamp without time zone,
  last_scan_activity_at timestamp without time zone,
  exact_complete_candidate_at timestamp without time zone,
  round1_scan_started_at timestamp without time zone,
  round1_delivery_started_at timestamp without time zone,
  round1_completed_at timestamp without time zone,
  round1_completion_detected_at timestamp without time zone,
  round1_completion_method text,
  round2_scan_started_at timestamp without time zone,
  round2_delivery_started_at timestamp without time zone,
  round2_completed_at timestamp without time zone,
  round2_completion_detected_at timestamp without time zone,
  round2_completion_method text,
  round3_scan_started_at timestamp without time zone,
  round3_delivery_started_at timestamp without time zone,
  round3_completed_at timestamp without time zone,
  round3_completion_detected_at timestamp without time zone,
  round3_completion_method text,
  completion_method text,
  completion_detected_at timestamp without time zone,
  work_completed_at timestamp without time zone,
  constraint meta_realtime_current_wave_check check(wave in ('WAVE1','WAVE2')),
  constraint meta_realtime_current_round_check check(current_round between 1 and 3 and expected_rounds between 1 and 3),
  constraint meta_realtime_current_fresh_miss_check check(fresh_miss in ('Y','N')),
  constraint meta_realtime_current_dawn_miss_check check(dawn_miss in ('Y','N'))
);

-- Upgrade existing tables, not only new installations.
alter table public.meta_realtime_current add column if not exists id uuid primary key default gen_random_uuid();
alter table public.meta_realtime_current add column if not exists batch_id uuid not null references public.meta_realtime_batch(id) on delete cascade;
alter table public.meta_realtime_current add column if not exists schedule_date date not null;
alter table public.meta_realtime_current add column if not exists meta_work_date date not null;
alter table public.meta_realtime_current add column if not exists camp_code text not null;
alter table public.meta_realtime_current add column if not exists camp_name text;
alter table public.meta_realtime_current add column if not exists wave text not null;
alter table public.meta_realtime_current add column if not exists coupang_id text;
alter table public.meta_realtime_current add column if not exists driver_name text;
alter table public.meta_realtime_current add column if not exists driver_account_type text;
alter table public.meta_realtime_current add column if not exists scheduled_routes text[] not null default array[]::text[];
alter table public.meta_realtime_current add column if not exists actual_routes text[] not null default array[]::text[];
alter table public.meta_realtime_current add column if not exists extra_routes text[];
alter table public.meta_realtime_current add column if not exists delivery_assigned integer not null default 0;
alter table public.meta_realtime_current add column if not exists delivery_scanned integer not null default 0;
alter table public.meta_realtime_current add column if not exists delivery_completed integer not null default 0;
alter table public.meta_realtime_current add column if not exists delivery_impossible integer not null default 0;
alter table public.meta_realtime_current add column if not exists delivery_pdd_miss integer not null default 0;
alter table public.meta_realtime_current add column if not exists delivery_total integer not null default 0;
alter table public.meta_realtime_current add column if not exists delivery_complete_rate numeric;
alter table public.meta_realtime_current add column if not exists return_pending integer default 0;
alter table public.meta_realtime_current add column if not exists return_collected integer default 0;
alter table public.meta_realtime_current add column if not exists return_uncollected_raw integer default 0;
alter table public.meta_realtime_current add column if not exists return_absent_raw integer default 0;
alter table public.meta_realtime_current add column if not exists return_uncollected integer;
alter table public.meta_realtime_current add column if not exists return_total integer default 0;
alter table public.meta_realtime_current add column if not exists return_attempt_rate numeric;
alter table public.meta_realtime_current add column if not exists return_collection_rate numeric;
alter table public.meta_realtime_current add column if not exists freshbag_pending integer not null default 0;
alter table public.meta_realtime_current add column if not exists freshbag_collected integer not null default 0;
alter table public.meta_realtime_current add column if not exists freshbag_uncollected integer not null default 0;
alter table public.meta_realtime_current add column if not exists freshbag_total integer not null default 0;
alter table public.meta_realtime_current add column if not exists freshbag_attempt_rate numeric;
alter table public.meta_realtime_current add column if not exists freshbag_collection_rate numeric;
alter table public.meta_realtime_current add column if not exists scan_started_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists delivery_started_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists delivery_completed_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists all_completed_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists first_seen_at timestamp without time zone not null default timezone('Asia/Seoul',now());
alter table public.meta_realtime_current add column if not exists last_seen_at timestamp without time zone not null default timezone('Asia/Seoul',now());
alter table public.meta_realtime_current add column if not exists delivery_done boolean not null default false;
alter table public.meta_realtime_current add column if not exists return_done boolean;
alter table public.meta_realtime_current add column if not exists freshbag_done boolean not null default false;
alter table public.meta_realtime_current add column if not exists raw_payload jsonb not null default '{}'::jsonb;
alter table public.meta_realtime_current add column if not exists created_at timestamp without time zone not null default timezone('Asia/Seoul',now());
alter table public.meta_realtime_current add column if not exists updated_at timestamp without time zone not null default timezone('Asia/Seoul',now());
alter table public.meta_realtime_current add column if not exists fresh_delivery_assigned integer not null default 0;
alter table public.meta_realtime_current add column if not exists fresh_delivery_scanned integer not null default 0;
alter table public.meta_realtime_current add column if not exists fresh_delivery_completed integer not null default 0;
alter table public.meta_realtime_current add column if not exists fresh_delivery_impossible integer not null default 0;
alter table public.meta_realtime_current add column if not exists fresh_delivery_pdd_miss integer not null default 0;
alter table public.meta_realtime_current add column if not exists fresh_delivery_total integer not null default 0;
alter table public.meta_realtime_current add column if not exists fresh_delivery_complete_rate numeric;
alter table public.meta_realtime_current add column if not exists meta_worker_key text not null;
alter table public.meta_realtime_current add column if not exists source_camp_code text;
alter table public.meta_realtime_current add column if not exists all_done boolean;
alter table public.meta_realtime_current add column if not exists share boolean not null default false;
alter table public.meta_realtime_current add column if not exists fresh_miss text not null default 'N';
alter table public.meta_realtime_current add column if not exists dawn_miss text not null default 'N';
alter table public.meta_realtime_current add column if not exists driver_pk bigint;
alter table public.meta_realtime_current add column if not exists current_round smallint not null default 1;
alter table public.meta_realtime_current add column if not exists expected_rounds smallint not null default 2;
alter table public.meta_realtime_current add column if not exists last_progress_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists last_scan_activity_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists exact_complete_candidate_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists round1_scan_started_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists round1_delivery_started_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists round1_completed_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists round1_completion_detected_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists round1_completion_method text;
alter table public.meta_realtime_current add column if not exists round2_scan_started_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists round2_delivery_started_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists round2_completed_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists round2_completion_detected_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists round2_completion_method text;
alter table public.meta_realtime_current add column if not exists round3_scan_started_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists round3_delivery_started_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists round3_completed_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists round3_completion_detected_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists round3_completion_method text;
alter table public.meta_realtime_current add column if not exists completion_method text;
alter table public.meta_realtime_current add column if not exists completion_detected_at timestamp without time zone;
alter table public.meta_realtime_current add column if not exists work_completed_at timestamp without time zone;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_current'::regclass and conname='meta_realtime_current_wave_check') then alter table public.meta_realtime_current add constraint meta_realtime_current_wave_check check(wave in ('WAVE1','WAVE2')); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_current'::regclass and conname='meta_realtime_current_round_check') then alter table public.meta_realtime_current add constraint meta_realtime_current_round_check check(current_round between 1 and 3 and expected_rounds between 1 and 3); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_current'::regclass and conname='meta_realtime_current_fresh_miss_check') then alter table public.meta_realtime_current add constraint meta_realtime_current_fresh_miss_check check(fresh_miss in ('Y','N')); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_current'::regclass and conname='meta_realtime_current_dawn_miss_check') then alter table public.meta_realtime_current add constraint meta_realtime_current_dawn_miss_check check(dawn_miss in ('Y','N')); end if; end $$;


create unique index if not exists meta_realtime_current_batch_worker_uq
  on public.meta_realtime_current(batch_id,meta_worker_key);
create index if not exists meta_realtime_current_coupang_idx
  on public.meta_realtime_current(coupang_id,schedule_date desc);
create index if not exists meta_realtime_current_driver_pk_idx
  on public.meta_realtime_current(driver_pk);
create index if not exists meta_realtime_current_lookup_idx
  on public.meta_realtime_current(schedule_date,camp_code,wave);
create index if not exists meta_realtime_current_share_idx
  on public.meta_realtime_current(share);

-- ============================================================================
-- 6. WAVE2 fresh delivery state
-- ============================================================================

create table if not exists public.meta_realtime_fresh_current (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.meta_realtime_batch(id) on delete cascade,
  schedule_date date not null,
  meta_work_date date not null,
  camp_code text,
  camp_name text not null,
  wave text not null,
  meta_worker_key text not null,
  coupang_id text,
  driver_name text,
  delivery_assigned integer not null default 0,
  delivery_scanned integer not null default 0,
  delivery_completed integer not null default 0,
  delivery_impossible integer not null default 0,
  delivery_pdd_miss integer not null default 0,
  delivery_total integer not null default 0,
  delivery_complete_rate numeric not null default 0,
  first_seen_at timestamp without time zone not null default timezone('Asia/Seoul',now()),
  last_seen_at timestamp without time zone not null default timezone('Asia/Seoul',now()),
  raw_payload jsonb,
  created_at timestamp without time zone not null default timezone('Asia/Seoul',now()),
  updated_at timestamp without time zone not null default timezone('Asia/Seoul',now()),
  fresh_miss text not null default 'N',
  driver_pk bigint,
  constraint meta_realtime_fresh_current_wave_check check(wave in ('WAVE1','WAVE2')),
  constraint meta_realtime_fresh_current_fresh_miss_check check(fresh_miss in ('Y','N')),
  constraint meta_realtime_fresh_current_delivery_complete_rate_check check(delivery_complete_rate between 0 and 100),
  constraint meta_realtime_fresh_current_batch_worker_key unique(batch_id,meta_worker_key)
);

-- Upgrade existing tables, not only new installations.
alter table public.meta_realtime_fresh_current add column if not exists id uuid primary key default gen_random_uuid();
alter table public.meta_realtime_fresh_current add column if not exists batch_id uuid not null references public.meta_realtime_batch(id) on delete cascade;
alter table public.meta_realtime_fresh_current add column if not exists schedule_date date not null;
alter table public.meta_realtime_fresh_current add column if not exists meta_work_date date not null;
alter table public.meta_realtime_fresh_current add column if not exists camp_code text;
alter table public.meta_realtime_fresh_current add column if not exists camp_name text not null;
alter table public.meta_realtime_fresh_current add column if not exists wave text not null;
alter table public.meta_realtime_fresh_current add column if not exists meta_worker_key text not null;
alter table public.meta_realtime_fresh_current add column if not exists coupang_id text;
alter table public.meta_realtime_fresh_current add column if not exists driver_name text;
alter table public.meta_realtime_fresh_current add column if not exists delivery_assigned integer not null default 0;
alter table public.meta_realtime_fresh_current add column if not exists delivery_scanned integer not null default 0;
alter table public.meta_realtime_fresh_current add column if not exists delivery_completed integer not null default 0;
alter table public.meta_realtime_fresh_current add column if not exists delivery_impossible integer not null default 0;
alter table public.meta_realtime_fresh_current add column if not exists delivery_pdd_miss integer not null default 0;
alter table public.meta_realtime_fresh_current add column if not exists delivery_total integer not null default 0;
alter table public.meta_realtime_fresh_current add column if not exists delivery_complete_rate numeric not null default 0;
alter table public.meta_realtime_fresh_current add column if not exists first_seen_at timestamp without time zone not null default timezone('Asia/Seoul',now());
alter table public.meta_realtime_fresh_current add column if not exists last_seen_at timestamp without time zone not null default timezone('Asia/Seoul',now());
alter table public.meta_realtime_fresh_current add column if not exists raw_payload jsonb;
alter table public.meta_realtime_fresh_current add column if not exists created_at timestamp without time zone not null default timezone('Asia/Seoul',now());
alter table public.meta_realtime_fresh_current add column if not exists updated_at timestamp without time zone not null default timezone('Asia/Seoul',now());
alter table public.meta_realtime_fresh_current add column if not exists fresh_miss text not null default 'N';
alter table public.meta_realtime_fresh_current add column if not exists driver_pk bigint;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_fresh_current'::regclass and conname='meta_realtime_fresh_current_wave_check') then alter table public.meta_realtime_fresh_current add constraint meta_realtime_fresh_current_wave_check check(wave in ('WAVE1','WAVE2')); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_fresh_current'::regclass and conname='meta_realtime_fresh_current_fresh_miss_check') then alter table public.meta_realtime_fresh_current add constraint meta_realtime_fresh_current_fresh_miss_check check(fresh_miss in ('Y','N')); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_fresh_current'::regclass and conname='meta_realtime_fresh_current_delivery_complete_rate_check') then alter table public.meta_realtime_fresh_current add constraint meta_realtime_fresh_current_delivery_complete_rate_check check(delivery_complete_rate between 0 and 100); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_fresh_current'::regclass and conname='meta_realtime_fresh_current_batch_worker_key') then alter table public.meta_realtime_fresh_current add constraint meta_realtime_fresh_current_batch_worker_key unique(batch_id,meta_worker_key); end if; end $$;


create index if not exists meta_realtime_fresh_current_batch_idx
  on public.meta_realtime_fresh_current(batch_id);
create index if not exists meta_realtime_fresh_current_coupang_idx
  on public.meta_realtime_fresh_current(coupang_id);
create index if not exists meta_realtime_fresh_current_driver_pk_idx
  on public.meta_realtime_fresh_current(driver_pk);
create index if not exists meta_realtime_fresh_current_schedule_idx
  on public.meta_realtime_fresh_current(schedule_date,wave,camp_name);

-- ============================================================================
-- 7. Per-minute history snapshots
-- ============================================================================

create table if not exists public.meta_realtime_history (
  id bigint generated always as identity primary key,
  batch_id uuid not null references public.meta_realtime_batch(id) on delete cascade,
  sampled_at timestamp without time zone not null,
  sample_minute timestamp without time zone not null,
  schedule_date date not null,
  meta_work_date date,
  camp_code text,
  camp_name text,
  wave text not null,
  meta_worker_key text not null,
  driver_pk bigint,
  coupang_id text,
  driver_name text,
  current_round smallint not null default 1,
  expected_rounds smallint not null default 2,
  delivery_assigned integer,
  delivery_scanned integer,
  delivery_completed integer,
  delivery_impossible integer,
  delivery_pdd_miss integer,
  delivery_total integer,
  delivery_complete_rate numeric,
  fresh_delivery_assigned integer,
  fresh_delivery_scanned integer,
  fresh_delivery_completed integer,
  fresh_delivery_impossible integer,
  fresh_delivery_pdd_miss integer,
  fresh_delivery_total integer,
  fresh_delivery_complete_rate numeric,
  return_pending integer,
  return_collected integer,
  return_uncollected integer,
  return_total integer,
  freshbag_pending integer,
  freshbag_collected integer,
  freshbag_uncollected integer,
  freshbag_total integer,
  delivery_remaining integer,
  total_remaining integer,
  actual_routes text[],
  created_at timestamp without time zone not null default timezone('Asia/Seoul',now())
);

-- Upgrade existing tables, not only new installations.
alter table public.meta_realtime_history add column if not exists id bigint generated always as identity primary key;
alter table public.meta_realtime_history add column if not exists batch_id uuid not null references public.meta_realtime_batch(id) on delete cascade;
alter table public.meta_realtime_history add column if not exists sampled_at timestamp without time zone not null;
alter table public.meta_realtime_history add column if not exists sample_minute timestamp without time zone not null;
alter table public.meta_realtime_history add column if not exists schedule_date date not null;
alter table public.meta_realtime_history add column if not exists meta_work_date date;
alter table public.meta_realtime_history add column if not exists camp_code text;
alter table public.meta_realtime_history add column if not exists camp_name text;
alter table public.meta_realtime_history add column if not exists wave text not null;
alter table public.meta_realtime_history add column if not exists meta_worker_key text not null;
alter table public.meta_realtime_history add column if not exists driver_pk bigint;
alter table public.meta_realtime_history add column if not exists coupang_id text;
alter table public.meta_realtime_history add column if not exists driver_name text;
alter table public.meta_realtime_history add column if not exists current_round smallint not null default 1;
alter table public.meta_realtime_history add column if not exists expected_rounds smallint not null default 2;
alter table public.meta_realtime_history add column if not exists delivery_assigned integer;
alter table public.meta_realtime_history add column if not exists delivery_scanned integer;
alter table public.meta_realtime_history add column if not exists delivery_completed integer;
alter table public.meta_realtime_history add column if not exists delivery_impossible integer;
alter table public.meta_realtime_history add column if not exists delivery_pdd_miss integer;
alter table public.meta_realtime_history add column if not exists delivery_total integer;
alter table public.meta_realtime_history add column if not exists delivery_complete_rate numeric;
alter table public.meta_realtime_history add column if not exists fresh_delivery_assigned integer;
alter table public.meta_realtime_history add column if not exists fresh_delivery_scanned integer;
alter table public.meta_realtime_history add column if not exists fresh_delivery_completed integer;
alter table public.meta_realtime_history add column if not exists fresh_delivery_impossible integer;
alter table public.meta_realtime_history add column if not exists fresh_delivery_pdd_miss integer;
alter table public.meta_realtime_history add column if not exists fresh_delivery_total integer;
alter table public.meta_realtime_history add column if not exists fresh_delivery_complete_rate numeric;
alter table public.meta_realtime_history add column if not exists return_pending integer;
alter table public.meta_realtime_history add column if not exists return_collected integer;
alter table public.meta_realtime_history add column if not exists return_uncollected integer;
alter table public.meta_realtime_history add column if not exists return_total integer;
alter table public.meta_realtime_history add column if not exists freshbag_pending integer;
alter table public.meta_realtime_history add column if not exists freshbag_collected integer;
alter table public.meta_realtime_history add column if not exists freshbag_uncollected integer;
alter table public.meta_realtime_history add column if not exists freshbag_total integer;
alter table public.meta_realtime_history add column if not exists delivery_remaining integer;
alter table public.meta_realtime_history add column if not exists total_remaining integer;
alter table public.meta_realtime_history add column if not exists actual_routes text[];
alter table public.meta_realtime_history add column if not exists created_at timestamp without time zone not null default timezone('Asia/Seoul',now());


create unique index if not exists meta_realtime_history_unique_minute
  on public.meta_realtime_history(batch_id,meta_worker_key,sample_minute);
create index if not exists idx_meta_realtime_history_batch_sample
  on public.meta_realtime_history(batch_id,sampled_at);
create index if not exists idx_meta_realtime_history_driver_sample
  on public.meta_realtime_history(driver_pk,sampled_at desc)
  where driver_pk is not null;
create index if not exists idx_meta_realtime_history_schedule_wave
  on public.meta_realtime_history(schedule_date,wave,camp_code,sampled_at);

-- ============================================================================
-- 8. Final/history worker rows
-- ============================================================================

create table if not exists public.meta_realtime_final (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.meta_realtime_batch(id) on delete cascade,
  schedule_date date not null,
  meta_work_date date not null,
  camp_code text not null,
  camp_name text,
  wave text not null,
  coupang_id text,
  driver_name text,
  driver_account_type text,
  scheduled_routes text[] not null default array[]::text[],
  actual_routes text[] not null default array[]::text[],
  extra_routes text[],
  delivery_assigned integer not null default 0,
  delivery_scanned integer not null default 0,
  delivery_completed integer not null default 0,
  delivery_impossible integer not null default 0,
  delivery_pdd_miss integer not null default 0,
  delivery_total integer not null default 0,
  delivery_complete_rate numeric,
  return_pending integer default 0,
  return_collected integer default 0,
  return_uncollected_raw integer default 0,
  return_absent_raw integer default 0,
  return_uncollected integer,
  return_total integer default 0,
  return_attempt_rate numeric,
  return_collection_rate numeric,
  freshbag_pending integer not null default 0,
  freshbag_collected integer not null default 0,
  freshbag_uncollected integer not null default 0,
  freshbag_total integer not null default 0,
  freshbag_attempt_rate numeric,
  freshbag_collection_rate numeric,
  scan_started_at timestamp without time zone,
  delivery_started_at timestamp without time zone,
  delivery_completed_at timestamp without time zone,
  all_completed_at timestamp without time zone,
  first_seen_at timestamp without time zone not null,
  last_seen_at timestamp without time zone not null,
  delivery_done boolean not null,
  return_done boolean,
  freshbag_done boolean not null,
  raw_payload jsonb not null default '{}'::jsonb,
  finalized_at timestamp without time zone not null default timezone('Asia/Seoul',now()),
  created_at timestamp without time zone not null default timezone('Asia/Seoul',now()),
  updated_at timestamp without time zone not null default timezone('Asia/Seoul',now()),
  fresh_delivery_assigned integer not null default 0,
  fresh_delivery_scanned integer not null default 0,
  fresh_delivery_completed integer not null default 0,
  fresh_delivery_impossible integer not null default 0,
  fresh_delivery_pdd_miss integer not null default 0,
  fresh_delivery_total integer not null default 0,
  fresh_delivery_complete_rate numeric,
  meta_worker_key text not null,
  source_camp_code text,
  all_done boolean,
  share boolean not null default false,
  fresh_miss text not null default 'N',
  dawn_miss text not null default 'N',
  driver_pk bigint,
  actual_rounds smallint,
  expected_rounds smallint not null default 2,
  round1_scan_started_at timestamp without time zone,
  round1_delivery_started_at timestamp without time zone,
  round1_completed_at timestamp without time zone,
  round1_completion_detected_at timestamp without time zone,
  round1_completion_method text,
  round2_scan_started_at timestamp without time zone,
  round2_delivery_started_at timestamp without time zone,
  round2_completed_at timestamp without time zone,
  round2_completion_detected_at timestamp without time zone,
  round2_completion_method text,
  round3_scan_started_at timestamp without time zone,
  round3_delivery_started_at timestamp without time zone,
  round3_completed_at timestamp without time zone,
  round3_completion_detected_at timestamp without time zone,
  round3_completion_method text,
  completion_method text,
  completion_detected_at timestamp without time zone,
  work_completed_at timestamp without time zone,
  constraint meta_realtime_final_wave_check check(wave in ('WAVE1','WAVE2')),
  constraint meta_realtime_final_fresh_miss_check check(fresh_miss in ('Y','N')),
  constraint meta_realtime_final_dawn_miss_check check(dawn_miss in ('Y','N')),
  constraint meta_realtime_final_rounds_check check((actual_rounds is null or actual_rounds between 1 and 3) and expected_rounds between 1 and 3)
);

-- Upgrade existing tables, not only new installations.
alter table public.meta_realtime_final add column if not exists id uuid primary key default gen_random_uuid();
alter table public.meta_realtime_final add column if not exists batch_id uuid not null references public.meta_realtime_batch(id) on delete cascade;
alter table public.meta_realtime_final add column if not exists schedule_date date not null;
alter table public.meta_realtime_final add column if not exists meta_work_date date not null;
alter table public.meta_realtime_final add column if not exists camp_code text not null;
alter table public.meta_realtime_final add column if not exists camp_name text;
alter table public.meta_realtime_final add column if not exists wave text not null;
alter table public.meta_realtime_final add column if not exists coupang_id text;
alter table public.meta_realtime_final add column if not exists driver_name text;
alter table public.meta_realtime_final add column if not exists driver_account_type text;
alter table public.meta_realtime_final add column if not exists scheduled_routes text[] not null default array[]::text[];
alter table public.meta_realtime_final add column if not exists actual_routes text[] not null default array[]::text[];
alter table public.meta_realtime_final add column if not exists extra_routes text[];
alter table public.meta_realtime_final add column if not exists delivery_assigned integer not null default 0;
alter table public.meta_realtime_final add column if not exists delivery_scanned integer not null default 0;
alter table public.meta_realtime_final add column if not exists delivery_completed integer not null default 0;
alter table public.meta_realtime_final add column if not exists delivery_impossible integer not null default 0;
alter table public.meta_realtime_final add column if not exists delivery_pdd_miss integer not null default 0;
alter table public.meta_realtime_final add column if not exists delivery_total integer not null default 0;
alter table public.meta_realtime_final add column if not exists delivery_complete_rate numeric;
alter table public.meta_realtime_final add column if not exists return_pending integer default 0;
alter table public.meta_realtime_final add column if not exists return_collected integer default 0;
alter table public.meta_realtime_final add column if not exists return_uncollected_raw integer default 0;
alter table public.meta_realtime_final add column if not exists return_absent_raw integer default 0;
alter table public.meta_realtime_final add column if not exists return_uncollected integer;
alter table public.meta_realtime_final add column if not exists return_total integer default 0;
alter table public.meta_realtime_final add column if not exists return_attempt_rate numeric;
alter table public.meta_realtime_final add column if not exists return_collection_rate numeric;
alter table public.meta_realtime_final add column if not exists freshbag_pending integer not null default 0;
alter table public.meta_realtime_final add column if not exists freshbag_collected integer not null default 0;
alter table public.meta_realtime_final add column if not exists freshbag_uncollected integer not null default 0;
alter table public.meta_realtime_final add column if not exists freshbag_total integer not null default 0;
alter table public.meta_realtime_final add column if not exists freshbag_attempt_rate numeric;
alter table public.meta_realtime_final add column if not exists freshbag_collection_rate numeric;
alter table public.meta_realtime_final add column if not exists scan_started_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists delivery_started_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists delivery_completed_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists all_completed_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists first_seen_at timestamp without time zone not null;
alter table public.meta_realtime_final add column if not exists last_seen_at timestamp without time zone not null;
alter table public.meta_realtime_final add column if not exists delivery_done boolean not null;
alter table public.meta_realtime_final add column if not exists return_done boolean;
alter table public.meta_realtime_final add column if not exists freshbag_done boolean not null;
alter table public.meta_realtime_final add column if not exists raw_payload jsonb not null default '{}'::jsonb;
alter table public.meta_realtime_final add column if not exists finalized_at timestamp without time zone not null default timezone('Asia/Seoul',now());
alter table public.meta_realtime_final add column if not exists created_at timestamp without time zone not null default timezone('Asia/Seoul',now());
alter table public.meta_realtime_final add column if not exists updated_at timestamp without time zone not null default timezone('Asia/Seoul',now());
alter table public.meta_realtime_final add column if not exists fresh_delivery_assigned integer not null default 0;
alter table public.meta_realtime_final add column if not exists fresh_delivery_scanned integer not null default 0;
alter table public.meta_realtime_final add column if not exists fresh_delivery_completed integer not null default 0;
alter table public.meta_realtime_final add column if not exists fresh_delivery_impossible integer not null default 0;
alter table public.meta_realtime_final add column if not exists fresh_delivery_pdd_miss integer not null default 0;
alter table public.meta_realtime_final add column if not exists fresh_delivery_total integer not null default 0;
alter table public.meta_realtime_final add column if not exists fresh_delivery_complete_rate numeric;
alter table public.meta_realtime_final add column if not exists meta_worker_key text not null;
alter table public.meta_realtime_final add column if not exists source_camp_code text;
alter table public.meta_realtime_final add column if not exists all_done boolean;
alter table public.meta_realtime_final add column if not exists share boolean not null default false;
alter table public.meta_realtime_final add column if not exists fresh_miss text not null default 'N';
alter table public.meta_realtime_final add column if not exists dawn_miss text not null default 'N';
alter table public.meta_realtime_final add column if not exists driver_pk bigint;
alter table public.meta_realtime_final add column if not exists actual_rounds smallint;
alter table public.meta_realtime_final add column if not exists expected_rounds smallint not null default 2;
alter table public.meta_realtime_final add column if not exists round1_scan_started_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists round1_delivery_started_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists round1_completed_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists round1_completion_detected_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists round1_completion_method text;
alter table public.meta_realtime_final add column if not exists round2_scan_started_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists round2_delivery_started_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists round2_completed_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists round2_completion_detected_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists round2_completion_method text;
alter table public.meta_realtime_final add column if not exists round3_scan_started_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists round3_delivery_started_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists round3_completed_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists round3_completion_detected_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists round3_completion_method text;
alter table public.meta_realtime_final add column if not exists completion_method text;
alter table public.meta_realtime_final add column if not exists completion_detected_at timestamp without time zone;
alter table public.meta_realtime_final add column if not exists work_completed_at timestamp without time zone;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_final'::regclass and conname='meta_realtime_final_wave_check') then alter table public.meta_realtime_final add constraint meta_realtime_final_wave_check check(wave in ('WAVE1','WAVE2')); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_final'::regclass and conname='meta_realtime_final_fresh_miss_check') then alter table public.meta_realtime_final add constraint meta_realtime_final_fresh_miss_check check(fresh_miss in ('Y','N')); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_final'::regclass and conname='meta_realtime_final_dawn_miss_check') then alter table public.meta_realtime_final add constraint meta_realtime_final_dawn_miss_check check(dawn_miss in ('Y','N')); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.meta_realtime_final'::regclass and conname='meta_realtime_final_rounds_check') then alter table public.meta_realtime_final add constraint meta_realtime_final_rounds_check check((actual_rounds is null or actual_rounds between 1 and 3) and expected_rounds between 1 and 3); end if; end $$;


create unique index if not exists meta_realtime_final_batch_worker_uq
  on public.meta_realtime_final(batch_id,meta_worker_key);
create index if not exists meta_realtime_final_coupang_idx
  on public.meta_realtime_final(coupang_id,schedule_date desc);
create index if not exists meta_realtime_final_driver_pk_idx
  on public.meta_realtime_final(driver_pk);
create index if not exists meta_realtime_final_lookup_idx
  on public.meta_realtime_final(schedule_date desc,camp_code,wave);
create index if not exists meta_realtime_final_share_idx
  on public.meta_realtime_final(share);

-- ============================================================================
-- 9. Optional tonest_info foreign keys
-- ============================================================================

DO $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='tonest_info' and column_name='pk_id' and udt_name='int8'
  ) then
    if not exists(select 1 from pg_constraint where conname='meta_realtime_current_driver_pk_fkey') then
      alter table public.meta_realtime_current
        add constraint meta_realtime_current_driver_pk_fkey
        foreign key(driver_pk) references public.tonest_info(pk_id)
        on update cascade on delete set null;
    end if;
    if not exists(select 1 from pg_constraint where conname='meta_realtime_fresh_current_driver_pk_fkey') then
      alter table public.meta_realtime_fresh_current
        add constraint meta_realtime_fresh_current_driver_pk_fkey
        foreign key(driver_pk) references public.tonest_info(pk_id)
        on update cascade on delete set null;
    end if;
    if not exists(select 1 from pg_constraint where conname='meta_realtime_history_driver_pk_fkey') then
      alter table public.meta_realtime_history
        add constraint meta_realtime_history_driver_pk_fkey
        foreign key(driver_pk) references public.tonest_info(pk_id)
        on update cascade on delete set null;
    end if;
    if not exists(select 1 from pg_constraint where conname='meta_realtime_final_driver_pk_fkey') then
      alter table public.meta_realtime_final
        add constraint meta_realtime_final_driver_pk_fkey
        foreign key(driver_pk) references public.tonest_info(pk_id)
        on update cascade on delete set null;
    end if;
  end if;
end $$;

-- ============================================================================
-- 10. Collector locks
-- ============================================================================

create or replace function public.meta_claim_realtime_batch(
  p_batch_id uuid,
  p_token uuid,
  p_lease_seconds integer default 120
)
returns boolean
language plpgsql
set search_path=''
as $$
declare
  v_rows integer;
begin
  update public.meta_realtime_batch
  set collector_lock_token=p_token,
      collector_lock_until=now()+make_interval(secs=>greatest(30,least(coalesce(p_lease_seconds,120),300))),
      updated_at=timezone('Asia/Seoul',now())
  where id=p_batch_id
    and (
      collector_lock_until is null
      or collector_lock_until<now()
      or collector_lock_token=p_token
    );
  get diagnostics v_rows=row_count;
  return v_rows=1;
end;
$$;

create or replace function public.meta_release_realtime_batch(
  p_batch_id uuid,
  p_token uuid
)
returns boolean
language plpgsql
set search_path=''
as $$
declare
  v_rows integer;
begin
  update public.meta_realtime_batch
  set collector_lock_token=null,
      collector_lock_until=null,
      updated_at=timezone('Asia/Seoul',now())
  where id=p_batch_id
    and collector_lock_token=p_token;
  get diagnostics v_rows=row_count;
  return v_rows=1;
end;
$$;

-- ============================================================================
-- 11. Finalize current -> final
-- ============================================================================

create or replace function public.meta_finalize_realtime_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_batch public.meta_realtime_batch%rowtype;
  v_current_count integer;
  v_final_count integer;
begin
  select * into v_batch
  from public.meta_realtime_batch
  where id=p_batch_id
  for update;

  if not found then
    raise exception 'META batch not found: %',p_batch_id;
  end if;

  if v_batch.status='finalized' then
    select count(*) into v_final_count
    from public.meta_realtime_final
    where batch_id=p_batch_id;
    return jsonb_build_object('ok',true,'already_finalized',true,'final_rows',v_final_count);
  end if;

  if v_batch.work_completed_at is null then
    raise exception 'META batch completion not confirmed: %',p_batch_id;
  end if;

  if timezone('Asia/Seoul',now()) < public.meta_realtime_metrics_close_at(v_batch.schedule_date,v_batch.wave) then
    raise exception 'META metrics close time has not been reached';
  end if;
  if exists(select 1 from public.meta_realtime_current c where c.batch_id=p_batch_id
    and (c.scan_started_at is not null or c.delivery_scanned>0 or c.delivery_completed>0)
    and (c.work_completed_at is null or c.current_round < case when c.wave='WAVE1' then 3 else 2 end)) then
    raise exception 'META final round is not complete';
  end if;
  -- Bring the latest fresh snapshot into the same transaction as finalization.
  update public.meta_realtime_current c set
    fresh_delivery_assigned=f.delivery_assigned,fresh_delivery_scanned=f.delivery_scanned,
    fresh_delivery_completed=f.delivery_completed,fresh_delivery_impossible=f.delivery_impossible,
    fresh_delivery_pdd_miss=f.delivery_pdd_miss,fresh_delivery_total=f.delivery_total,
    fresh_delivery_complete_rate=f.delivery_complete_rate
  from public.meta_realtime_fresh_current f
  where c.batch_id=p_batch_id and f.batch_id=c.batch_id and f.meta_worker_key=c.meta_worker_key;

  select count(*) into v_current_count
  from public.meta_realtime_current
  where batch_id=p_batch_id;

  if v_current_count=0 then
    raise exception 'META batch has no current rows: %',p_batch_id;
  end if;

  insert into public.meta_realtime_final(
    batch_id,schedule_date,meta_work_date,camp_code,camp_name,wave,
    coupang_id,driver_name,driver_account_type,scheduled_routes,actual_routes,extra_routes,
    delivery_assigned,delivery_scanned,delivery_completed,delivery_impossible,delivery_pdd_miss,delivery_total,delivery_complete_rate,
    return_pending,return_collected,return_uncollected_raw,return_absent_raw,return_uncollected,return_total,return_attempt_rate,return_collection_rate,
    freshbag_pending,freshbag_collected,freshbag_uncollected,freshbag_total,freshbag_attempt_rate,freshbag_collection_rate,
    scan_started_at,delivery_started_at,delivery_completed_at,all_completed_at,first_seen_at,last_seen_at,
    delivery_done,return_done,freshbag_done,raw_payload,
    fresh_delivery_assigned,fresh_delivery_scanned,fresh_delivery_completed,fresh_delivery_impossible,fresh_delivery_pdd_miss,fresh_delivery_total,fresh_delivery_complete_rate,
    meta_worker_key,source_camp_code,all_done,share,fresh_miss,dawn_miss,driver_pk,
    actual_rounds,expected_rounds,
    round1_scan_started_at,round1_delivery_started_at,round1_completed_at,round1_completion_detected_at,round1_completion_method,
    round2_scan_started_at,round2_delivery_started_at,round2_completed_at,round2_completion_detected_at,round2_completion_method,
    round3_scan_started_at,round3_delivery_started_at,round3_completed_at,round3_completion_detected_at,round3_completion_method,
    completion_method,completion_detected_at,work_completed_at,
    finalized_at,created_at,updated_at
  )
  select
    batch_id,schedule_date,meta_work_date,camp_code,camp_name,wave,
    coupang_id,driver_name,driver_account_type,scheduled_routes,actual_routes,extra_routes,
    delivery_assigned,delivery_scanned,delivery_completed,delivery_impossible,delivery_pdd_miss,delivery_total,delivery_complete_rate,
    return_pending,return_collected,return_uncollected_raw,return_absent_raw,
    coalesce(return_uncollected,greatest(coalesce(return_uncollected_raw,0),coalesce(return_absent_raw,0))),
    return_total,return_attempt_rate,return_collection_rate,
    freshbag_pending,freshbag_collected,freshbag_uncollected,freshbag_total,freshbag_attempt_rate,freshbag_collection_rate,
    scan_started_at,delivery_started_at,delivery_completed_at,coalesce(work_completed_at,all_completed_at),first_seen_at,last_seen_at,
    delivery_done,return_done,freshbag_done,raw_payload,
    fresh_delivery_assigned,fresh_delivery_scanned,fresh_delivery_completed,fresh_delivery_impossible,fresh_delivery_pdd_miss,fresh_delivery_total,fresh_delivery_complete_rate,
    meta_worker_key,source_camp_code,all_done,share,fresh_miss,dawn_miss,driver_pk,
    current_round,expected_rounds,
    round1_scan_started_at,round1_delivery_started_at,round1_completed_at,round1_completion_detected_at,round1_completion_method,
    round2_scan_started_at,round2_delivery_started_at,round2_completed_at,round2_completion_detected_at,round2_completion_method,
    round3_scan_started_at,round3_delivery_started_at,round3_completed_at,round3_completion_detected_at,round3_completion_method,
    completion_method,completion_detected_at,work_completed_at,
    timezone('Asia/Seoul',now()),created_at,timezone('Asia/Seoul',now())
  from public.meta_realtime_current
  where batch_id=p_batch_id
  on conflict(batch_id,meta_worker_key) do update set
    coupang_id=excluded.coupang_id,
    driver_name=excluded.driver_name,
    driver_account_type=excluded.driver_account_type,
    scheduled_routes=excluded.scheduled_routes,
    actual_routes=excluded.actual_routes,
    extra_routes=excluded.extra_routes,
    delivery_assigned=excluded.delivery_assigned,
    delivery_scanned=excluded.delivery_scanned,
    delivery_completed=excluded.delivery_completed,
    delivery_impossible=excluded.delivery_impossible,
    delivery_pdd_miss=excluded.delivery_pdd_miss,
    delivery_total=excluded.delivery_total,
    delivery_complete_rate=excluded.delivery_complete_rate,
    return_pending=excluded.return_pending,
    return_collected=excluded.return_collected,
    return_uncollected_raw=excluded.return_uncollected_raw,
    return_absent_raw=excluded.return_absent_raw,
    return_uncollected=excluded.return_uncollected,
    return_total=excluded.return_total,
    return_attempt_rate=excluded.return_attempt_rate,
    return_collection_rate=excluded.return_collection_rate,
    freshbag_pending=excluded.freshbag_pending,
    freshbag_collected=excluded.freshbag_collected,
    freshbag_uncollected=excluded.freshbag_uncollected,
    freshbag_total=excluded.freshbag_total,
    freshbag_attempt_rate=excluded.freshbag_attempt_rate,
    freshbag_collection_rate=excluded.freshbag_collection_rate,
    scan_started_at=excluded.scan_started_at,
    delivery_started_at=excluded.delivery_started_at,
    delivery_completed_at=excluded.delivery_completed_at,
    all_completed_at=excluded.all_completed_at,
    last_seen_at=excluded.last_seen_at,
    delivery_done=excluded.delivery_done,
    return_done=excluded.return_done,
    freshbag_done=excluded.freshbag_done,
    raw_payload=excluded.raw_payload,
    fresh_delivery_assigned=excluded.fresh_delivery_assigned,
    fresh_delivery_scanned=excluded.fresh_delivery_scanned,
    fresh_delivery_completed=excluded.fresh_delivery_completed,
    fresh_delivery_impossible=excluded.fresh_delivery_impossible,
    fresh_delivery_pdd_miss=excluded.fresh_delivery_pdd_miss,
    fresh_delivery_total=excluded.fresh_delivery_total,
    fresh_delivery_complete_rate=excluded.fresh_delivery_complete_rate,
    source_camp_code=excluded.source_camp_code,
    all_done=excluded.all_done,
    share=excluded.share,
    fresh_miss=excluded.fresh_miss,
    dawn_miss=excluded.dawn_miss,
    driver_pk=excluded.driver_pk,
    actual_rounds=excluded.actual_rounds,
    expected_rounds=excluded.expected_rounds,
    round1_scan_started_at=excluded.round1_scan_started_at,
    round1_delivery_started_at=excluded.round1_delivery_started_at,
    round1_completed_at=excluded.round1_completed_at,
    round1_completion_detected_at=excluded.round1_completion_detected_at,
    round1_completion_method=excluded.round1_completion_method,
    round2_scan_started_at=excluded.round2_scan_started_at,
    round2_delivery_started_at=excluded.round2_delivery_started_at,
    round2_completed_at=excluded.round2_completed_at,
    round2_completion_detected_at=excluded.round2_completion_detected_at,
    round2_completion_method=excluded.round2_completion_method,
    round3_scan_started_at=excluded.round3_scan_started_at,
    round3_delivery_started_at=excluded.round3_delivery_started_at,
    round3_completed_at=excluded.round3_completed_at,
    round3_completion_detected_at=excluded.round3_completion_detected_at,
    round3_completion_method=excluded.round3_completion_method,
    completion_method=excluded.completion_method,
    completion_detected_at=excluded.completion_detected_at,
    work_completed_at=excluded.work_completed_at,
    finalized_at=excluded.finalized_at,
    updated_at=timezone('Asia/Seoul',now());

  select count(*) into v_final_count from public.meta_realtime_final where batch_id=p_batch_id;
  if v_final_count < v_current_count then raise exception 'Final snapshot count mismatch; no current rows deleted'; end if;
  delete from public.meta_realtime_current where batch_id=p_batch_id;
  delete from public.meta_realtime_fresh_current where batch_id=p_batch_id;

  update public.meta_realtime_batch
  set status='finalized',
      metrics_status='closed',
      metrics_closed_at=coalesce(metrics_closed_at,timezone('Asia/Seoul',now())),
      finalized_at=coalesce(finalized_at,timezone('Asia/Seoul',now())),
      completion_method=coalesce(completion_method,'work_completed'),
      completion_detected_at=coalesce(completion_detected_at,timezone('Asia/Seoul',now())),
      last_polled_at=coalesce(last_polled_at,timezone('Asia/Seoul',now())),
      poll_interval_seconds=300,
      next_poll_at=timezone('Asia/Seoul',now())+interval '5 minutes',
      last_error=null,
      updated_at=timezone('Asia/Seoul',now())
  where id=p_batch_id;

  select count(*) into v_final_count
  from public.meta_realtime_final
  where batch_id=p_batch_id;

  return jsonb_build_object('ok',true,'already_finalized',false,'final_rows',v_final_count);
end;
$$;

-- ============================================================================
-- 12. TO:NEST auth helpers
--     current TO:NEST profiles model:
--       profiles(user_id,email,display_name,role,status)
-- ============================================================================

create or replace function public.tn_has_active_profile()
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select exists(
    select 1 from public.profiles p
    where p.user_id=auth.uid()
      and p.status='active'
  )
$$;

create or replace function public.tn_can_read_realtime()
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select exists(
    select 1 from public.profiles p
    where p.user_id=auth.uid()
      and p.status='active'
      and p.role in ('super_admin','admin','team_leader')
  )
$$;

create or replace function public.tn_can_manage_schedule()
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select exists(
    select 1 from public.profiles p
    where p.user_id=auth.uid()
      and p.status='active'
      and p.role in ('super_admin','admin','team_leader')
  )
$$;

create or replace function public.tn_is_super_admin()
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select exists(
    select 1 from public.profiles p
    where p.user_id=auth.uid()
      and p.status='active'
      and p.role='super_admin'
  )
$$;

create or replace function public.tn_meta_collector_state()
returns table(
  paused boolean,
  status text,
  last_success_at timestamptz,
  last_http_status integer,
  last_error text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path=''
as $$
  select
    s.collector_paused,
    s.status,
    s.last_success_at,
    s.last_http_status,
    s.last_error,
    s.updated_at
  from public.meta_backend_state s
  where s.id=1
    and public.tn_can_read_realtime()
$$;

create or replace function public.tn_set_meta_collector_paused(p_paused boolean)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
begin
  if not public.tn_is_super_admin() then
    raise exception 'super_admin only';
  end if;

  update public.meta_backend_state
  set collector_paused=coalesce(p_paused,false),
      collector_paused_at=case when coalesce(p_paused,false) then now() else null end,
      collector_paused_by=case when coalesce(p_paused,false) then auth.uid() else null end,
      updated_at=now()
  where id=1;

  return true;
end;
$$;

-- ============================================================================
-- 13. RLS / grants
-- ============================================================================

alter table public.tonest_schedule enable row level security;
alter table public.meta_backend_state enable row level security;
alter table public.meta_realtime_batch enable row level security;
alter table public.meta_realtime_current enable row level security;
alter table public.meta_realtime_fresh_current enable row level security;
alter table public.meta_realtime_history enable row level security;
alter table public.meta_realtime_final enable row level security;

-- schedule: active account read / team leader+ write
DROP POLICY IF EXISTS tonest_schedule_select ON public.tonest_schedule;
CREATE POLICY tonest_schedule_select
ON public.tonest_schedule FOR SELECT TO authenticated
USING(public.tn_has_active_profile());

DROP POLICY IF EXISTS tonest_schedule_insert ON public.tonest_schedule;
CREATE POLICY tonest_schedule_insert
ON public.tonest_schedule FOR INSERT TO authenticated
WITH CHECK(public.tn_can_manage_schedule());

DROP POLICY IF EXISTS tonest_schedule_update ON public.tonest_schedule;
CREATE POLICY tonest_schedule_update
ON public.tonest_schedule FOR UPDATE TO authenticated
USING(public.tn_can_manage_schedule())
WITH CHECK(public.tn_can_manage_schedule());

DROP POLICY IF EXISTS tonest_schedule_delete ON public.tonest_schedule;
CREATE POLICY tonest_schedule_delete
ON public.tonest_schedule FOR DELETE TO authenticated
USING(public.tn_can_manage_schedule());

-- realtime: team leader+ read only
DROP POLICY IF EXISTS meta_realtime_batch_tonest_select ON public.meta_realtime_batch;
CREATE POLICY meta_realtime_batch_tonest_select
ON public.meta_realtime_batch FOR SELECT TO authenticated
USING(public.tn_can_read_realtime());

DROP POLICY IF EXISTS meta_realtime_current_tonest_select ON public.meta_realtime_current;
CREATE POLICY meta_realtime_current_tonest_select
ON public.meta_realtime_current FOR SELECT TO authenticated
USING(public.tn_can_read_realtime());

DROP POLICY IF EXISTS meta_realtime_fresh_current_tonest_select ON public.meta_realtime_fresh_current;
CREATE POLICY meta_realtime_fresh_current_tonest_select
ON public.meta_realtime_fresh_current FOR SELECT TO authenticated
USING(public.tn_can_read_realtime());

DROP POLICY IF EXISTS meta_realtime_history_tonest_select ON public.meta_realtime_history;
CREATE POLICY meta_realtime_history_tonest_select
ON public.meta_realtime_history FOR SELECT TO authenticated
USING(public.tn_can_read_realtime());

DROP POLICY IF EXISTS meta_realtime_final_tonest_select ON public.meta_realtime_final;
CREATE POLICY meta_realtime_final_tonest_select
ON public.meta_realtime_final FOR SELECT TO authenticated
USING(public.tn_can_read_realtime());

-- meta_backend_state 는 cookie_bundle 때문에 브라우저 직접 SELECT 정책을 만들지 않는다.

-- Explicit Data API privileges
grant select on public.tonest_schedule to authenticated;
grant insert,update,delete on public.tonest_schedule to authenticated;
grant select on public.meta_realtime_batch to authenticated;
grant select on public.meta_realtime_current to authenticated;
grant select on public.meta_realtime_fresh_current to authenticated;
grant select on public.meta_realtime_history to authenticated;
grant select on public.meta_realtime_final to authenticated;

-- Function privileges: PUBLIC 기본 실행권을 명시적으로 제거
revoke all on function public.tn_has_active_profile() from public,anon,authenticated;
revoke all on function public.tn_can_read_realtime() from public,anon,authenticated;
revoke all on function public.tn_can_manage_schedule() from public,anon,authenticated;
revoke all on function public.tn_is_super_admin() from public,anon,authenticated;
revoke all on function public.tn_meta_collector_state() from public,anon,authenticated;
revoke all on function public.tn_set_meta_collector_paused(boolean) from public,anon,authenticated;
revoke all on function public.meta_claim_realtime_batch(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.meta_release_realtime_batch(uuid,uuid) from public,anon,authenticated;
revoke all on function public.meta_finalize_realtime_batch(uuid) from public,anon,authenticated;

grant execute on function public.tn_has_active_profile() to authenticated;
grant execute on function public.tn_can_read_realtime() to authenticated;
grant execute on function public.tn_can_manage_schedule() to authenticated;
grant execute on function public.tn_is_super_admin() to authenticated;
grant execute on function public.tn_meta_collector_state() to authenticated;
grant execute on function public.tn_set_meta_collector_paused(boolean) to authenticated;

grant execute on function public.meta_claim_realtime_batch(uuid,uuid,integer) to service_role;
grant execute on function public.meta_release_realtime_batch(uuid,uuid) to service_role;
grant execute on function public.meta_finalize_realtime_batch(uuid) to service_role;


revoke all on public.meta_backend_state from anon,authenticated;
grant all on public.meta_backend_state,public.meta_realtime_batch,public.meta_realtime_current,
  public.meta_realtime_fresh_current,public.meta_realtime_history,public.meta_realtime_final to service_role;
grant select on public.tonest_schedule,public.tonest_info to service_role;

-- Database policy matches collector and UI. Historical snapshots are not rewritten.
create or replace function public.tn_realtime_expected_rounds()
returns trigger language plpgsql set search_path='' as $$
begin new.expected_rounds := case when new.wave='WAVE1' then 3 else 2 end; return new; end $$;
revoke all on function public.tn_realtime_expected_rounds() from public,anon,authenticated;
drop trigger if exists tn_expected_rounds on public.meta_realtime_batch;
create trigger tn_expected_rounds before insert or update of wave,expected_rounds on public.meta_realtime_batch
for each row execute function public.tn_realtime_expected_rounds();
drop trigger if exists tn_expected_rounds on public.meta_realtime_current;
create trigger tn_expected_rounds before insert or update of wave,expected_rounds on public.meta_realtime_current
for each row execute function public.tn_realtime_expected_rounds();
drop trigger if exists tn_expected_rounds on public.meta_realtime_history;
create trigger tn_expected_rounds before insert or update of wave,expected_rounds on public.meta_realtime_history
for each row execute function public.tn_realtime_expected_rounds();
drop trigger if exists tn_expected_rounds on public.meta_realtime_final;
create trigger tn_expected_rounds before insert or update of wave,expected_rounds on public.meta_realtime_final
for each row execute function public.tn_realtime_expected_rounds();

-- Only active state is reconciled; never invent a missing third-round timestamp.
update public.meta_realtime_batch set expected_rounds=case when wave='WAVE1' then 3 else 2 end
where status <> 'finalized' and expected_rounds <> case when wave='WAVE1' then 3 else 2 end;
update public.meta_realtime_current c set expected_rounds=case when c.wave='WAVE1' then 3 else 2 end
from public.meta_realtime_batch b where c.batch_id=b.id and b.status <> 'finalized';
update public.meta_realtime_current c set work_completed_at=null,all_completed_at=null,
  delivery_completed_at=null,all_done=false,completion_method=null,completion_detected_at=null,
  exact_complete_candidate_at=null
from public.meta_realtime_batch b
where c.batch_id=b.id and b.status<>'finalized' and c.wave='WAVE1'
  and (c.current_round<3 or c.round3_delivery_started_at is null)
  and (c.work_completed_at is not null or c.all_done=true);
update public.meta_realtime_batch b set work_completed_at=null,completion_candidate_at=null,
  completion_detected_at=null,completion_method=null,stable_complete_poll_count=0,
  completed_worker_count=(select count(*) from public.meta_realtime_current c where c.batch_id=b.id and c.work_completed_at is not null),
  status=case when status='completion_candidate' then 'collecting' else status end
where b.wave='WAVE1' and b.status<>'finalized'
  and exists(select 1 from public.meta_realtime_current c where c.batch_id=b.id and c.work_completed_at is null);

-- Fail closed on incompatible existing types. No implicit destructive conversion.
do $$ declare problems text; begin
with expected(table_name,column_name,udt_name) as (values
('tonest_schedule','id','uuid'),
('tonest_schedule','schedule_date','date'),
('tonest_schedule','iso_year','int4'),
('tonest_schedule','iso_week','int4'),
('tonest_schedule','week_label','text'),
('tonest_schedule','camp','text'),
('tonest_schedule','route_label','text'),
('tonest_schedule','driver_name','text'),
('tonest_schedule','memo','text'),
('tonest_schedule','row_order','int4'),
('tonest_schedule','cell_color','text'),
('tonest_schedule','is_active','bool'),
('tonest_schedule','created_at','timestamptz'),
('tonest_schedule','updated_at','timestamptz'),
('tonest_schedule','wave','text'),
('tonest_schedule','driver_display_name','text'),
('tonest_schedule','driver_owner_name','text'),
('tonest_schedule','driver_export_name','text'),
('tonest_schedule','driver_coupang_id','text'),
('tonest_schedule','driver_account_type','text'),
('tonest_schedule','driver_pk','int8'),
('meta_backend_state','id','int2'),
('meta_backend_state','cookie_bundle','text'),
('meta_backend_state','status','text'),
('meta_backend_state','updated_at','timestamptz'),
('meta_backend_state','last_success_at','timestamptz'),
('meta_backend_state','last_http_status','int4'),
('meta_backend_state','last_error','text'),
('meta_backend_state','collector_paused','bool'),
('meta_backend_state','collector_paused_at','timestamptz'),
('meta_backend_state','collector_paused_by','uuid'),
('meta_realtime_batch','id','uuid'),
('meta_realtime_batch','schedule_date','date'),
('meta_realtime_batch','meta_work_date','date'),
('meta_realtime_batch','camp_code','text'),
('meta_realtime_batch','camp_name','text'),
('meta_realtime_batch','wave','text'),
('meta_realtime_batch','status','text'),
('meta_realtime_batch','collect_from','timestamp'),
('meta_realtime_batch','collect_until','timestamp'),
('meta_realtime_batch','started_at','timestamp'),
('meta_realtime_batch','last_polled_at','timestamp'),
('meta_realtime_batch','completion_candidate_at','timestamp'),
('meta_realtime_batch','finalized_at','timestamp'),
('meta_realtime_batch','worker_count','int4'),
('meta_realtime_batch','completed_worker_count','int4'),
('meta_realtime_batch','stable_complete_poll_count','int2'),
('meta_realtime_batch','poll_interval_seconds','int4'),
('meta_realtime_batch','next_poll_at','timestamp'),
('meta_realtime_batch','last_error','text'),
('meta_realtime_batch','created_at','timestamp'),
('meta_realtime_batch','updated_at','timestamp'),
('meta_realtime_batch','meta_camp_codes','_text'),
('meta_realtime_batch','fresh_miss','text'),
('meta_realtime_batch','dawn_miss','text'),
('meta_realtime_batch','expected_rounds','int2'),
('meta_realtime_batch','completion_method','text'),
('meta_realtime_batch','completion_detected_at','timestamp'),
('meta_realtime_batch','collector_lock_token','uuid'),
('meta_realtime_batch','collector_lock_until','timestamptz'),
('meta_realtime_batch','work_completed_at','timestamp'),
('meta_realtime_batch','metrics_status','text'),
('meta_realtime_batch','metrics_closed_at','timestamp'),
('meta_realtime_batch','visible_until','timestamp'),
('meta_realtime_batch','metrics_close_at','timestamp'),
('meta_realtime_current','id','uuid'),
('meta_realtime_current','batch_id','uuid'),
('meta_realtime_current','schedule_date','date'),
('meta_realtime_current','meta_work_date','date'),
('meta_realtime_current','camp_code','text'),
('meta_realtime_current','camp_name','text'),
('meta_realtime_current','wave','text'),
('meta_realtime_current','coupang_id','text'),
('meta_realtime_current','driver_name','text'),
('meta_realtime_current','driver_account_type','text'),
('meta_realtime_current','scheduled_routes','_text'),
('meta_realtime_current','actual_routes','_text'),
('meta_realtime_current','extra_routes','_text'),
('meta_realtime_current','delivery_assigned','int4'),
('meta_realtime_current','delivery_scanned','int4'),
('meta_realtime_current','delivery_completed','int4'),
('meta_realtime_current','delivery_impossible','int4'),
('meta_realtime_current','delivery_pdd_miss','int4'),
('meta_realtime_current','delivery_total','int4'),
('meta_realtime_current','delivery_complete_rate','numeric'),
('meta_realtime_current','return_pending','int4'),
('meta_realtime_current','return_collected','int4'),
('meta_realtime_current','return_uncollected_raw','int4'),
('meta_realtime_current','return_absent_raw','int4'),
('meta_realtime_current','return_uncollected','int4'),
('meta_realtime_current','return_total','int4'),
('meta_realtime_current','return_attempt_rate','numeric'),
('meta_realtime_current','return_collection_rate','numeric'),
('meta_realtime_current','freshbag_pending','int4'),
('meta_realtime_current','freshbag_collected','int4'),
('meta_realtime_current','freshbag_uncollected','int4'),
('meta_realtime_current','freshbag_total','int4'),
('meta_realtime_current','freshbag_attempt_rate','numeric'),
('meta_realtime_current','freshbag_collection_rate','numeric'),
('meta_realtime_current','scan_started_at','timestamp'),
('meta_realtime_current','delivery_started_at','timestamp'),
('meta_realtime_current','delivery_completed_at','timestamp'),
('meta_realtime_current','all_completed_at','timestamp'),
('meta_realtime_current','first_seen_at','timestamp'),
('meta_realtime_current','last_seen_at','timestamp'),
('meta_realtime_current','delivery_done','bool'),
('meta_realtime_current','return_done','bool'),
('meta_realtime_current','freshbag_done','bool'),
('meta_realtime_current','raw_payload','jsonb'),
('meta_realtime_current','created_at','timestamp'),
('meta_realtime_current','updated_at','timestamp'),
('meta_realtime_current','fresh_delivery_assigned','int4'),
('meta_realtime_current','fresh_delivery_scanned','int4'),
('meta_realtime_current','fresh_delivery_completed','int4'),
('meta_realtime_current','fresh_delivery_impossible','int4'),
('meta_realtime_current','fresh_delivery_pdd_miss','int4'),
('meta_realtime_current','fresh_delivery_total','int4'),
('meta_realtime_current','fresh_delivery_complete_rate','numeric'),
('meta_realtime_current','meta_worker_key','text'),
('meta_realtime_current','source_camp_code','text'),
('meta_realtime_current','all_done','bool'),
('meta_realtime_current','share','bool'),
('meta_realtime_current','fresh_miss','text'),
('meta_realtime_current','dawn_miss','text'),
('meta_realtime_current','driver_pk','int8'),
('meta_realtime_current','current_round','int2'),
('meta_realtime_current','expected_rounds','int2'),
('meta_realtime_current','last_progress_at','timestamp'),
('meta_realtime_current','last_scan_activity_at','timestamp'),
('meta_realtime_current','exact_complete_candidate_at','timestamp'),
('meta_realtime_current','round1_scan_started_at','timestamp'),
('meta_realtime_current','round1_delivery_started_at','timestamp'),
('meta_realtime_current','round1_completed_at','timestamp'),
('meta_realtime_current','round1_completion_detected_at','timestamp'),
('meta_realtime_current','round1_completion_method','text'),
('meta_realtime_current','round2_scan_started_at','timestamp'),
('meta_realtime_current','round2_delivery_started_at','timestamp'),
('meta_realtime_current','round2_completed_at','timestamp'),
('meta_realtime_current','round2_completion_detected_at','timestamp'),
('meta_realtime_current','round2_completion_method','text'),
('meta_realtime_current','round3_scan_started_at','timestamp'),
('meta_realtime_current','round3_delivery_started_at','timestamp'),
('meta_realtime_current','round3_completed_at','timestamp'),
('meta_realtime_current','round3_completion_detected_at','timestamp'),
('meta_realtime_current','round3_completion_method','text'),
('meta_realtime_current','completion_method','text'),
('meta_realtime_current','completion_detected_at','timestamp'),
('meta_realtime_current','work_completed_at','timestamp'),
('meta_realtime_fresh_current','id','uuid'),
('meta_realtime_fresh_current','batch_id','uuid'),
('meta_realtime_fresh_current','schedule_date','date'),
('meta_realtime_fresh_current','meta_work_date','date'),
('meta_realtime_fresh_current','camp_code','text'),
('meta_realtime_fresh_current','camp_name','text'),
('meta_realtime_fresh_current','wave','text'),
('meta_realtime_fresh_current','meta_worker_key','text'),
('meta_realtime_fresh_current','coupang_id','text'),
('meta_realtime_fresh_current','driver_name','text'),
('meta_realtime_fresh_current','delivery_assigned','int4'),
('meta_realtime_fresh_current','delivery_scanned','int4'),
('meta_realtime_fresh_current','delivery_completed','int4'),
('meta_realtime_fresh_current','delivery_impossible','int4'),
('meta_realtime_fresh_current','delivery_pdd_miss','int4'),
('meta_realtime_fresh_current','delivery_total','int4'),
('meta_realtime_fresh_current','delivery_complete_rate','numeric'),
('meta_realtime_fresh_current','first_seen_at','timestamp'),
('meta_realtime_fresh_current','last_seen_at','timestamp'),
('meta_realtime_fresh_current','raw_payload','jsonb'),
('meta_realtime_fresh_current','created_at','timestamp'),
('meta_realtime_fresh_current','updated_at','timestamp'),
('meta_realtime_fresh_current','fresh_miss','text'),
('meta_realtime_fresh_current','driver_pk','int8'),
('meta_realtime_history','id','int8'),
('meta_realtime_history','batch_id','uuid'),
('meta_realtime_history','sampled_at','timestamp'),
('meta_realtime_history','sample_minute','timestamp'),
('meta_realtime_history','schedule_date','date'),
('meta_realtime_history','meta_work_date','date'),
('meta_realtime_history','camp_code','text'),
('meta_realtime_history','camp_name','text'),
('meta_realtime_history','wave','text'),
('meta_realtime_history','meta_worker_key','text'),
('meta_realtime_history','driver_pk','int8'),
('meta_realtime_history','coupang_id','text'),
('meta_realtime_history','driver_name','text'),
('meta_realtime_history','current_round','int2'),
('meta_realtime_history','expected_rounds','int2'),
('meta_realtime_history','delivery_assigned','int4'),
('meta_realtime_history','delivery_scanned','int4'),
('meta_realtime_history','delivery_completed','int4'),
('meta_realtime_history','delivery_impossible','int4'),
('meta_realtime_history','delivery_pdd_miss','int4'),
('meta_realtime_history','delivery_total','int4'),
('meta_realtime_history','delivery_complete_rate','numeric'),
('meta_realtime_history','fresh_delivery_assigned','int4'),
('meta_realtime_history','fresh_delivery_scanned','int4'),
('meta_realtime_history','fresh_delivery_completed','int4'),
('meta_realtime_history','fresh_delivery_impossible','int4'),
('meta_realtime_history','fresh_delivery_pdd_miss','int4'),
('meta_realtime_history','fresh_delivery_total','int4'),
('meta_realtime_history','fresh_delivery_complete_rate','numeric'),
('meta_realtime_history','return_pending','int4'),
('meta_realtime_history','return_collected','int4'),
('meta_realtime_history','return_uncollected','int4'),
('meta_realtime_history','return_total','int4'),
('meta_realtime_history','freshbag_pending','int4'),
('meta_realtime_history','freshbag_collected','int4'),
('meta_realtime_history','freshbag_uncollected','int4'),
('meta_realtime_history','freshbag_total','int4'),
('meta_realtime_history','delivery_remaining','int4'),
('meta_realtime_history','total_remaining','int4'),
('meta_realtime_history','actual_routes','_text'),
('meta_realtime_history','created_at','timestamp'),
('meta_realtime_final','id','uuid'),
('meta_realtime_final','batch_id','uuid'),
('meta_realtime_final','schedule_date','date'),
('meta_realtime_final','meta_work_date','date'),
('meta_realtime_final','camp_code','text'),
('meta_realtime_final','camp_name','text'),
('meta_realtime_final','wave','text'),
('meta_realtime_final','coupang_id','text'),
('meta_realtime_final','driver_name','text'),
('meta_realtime_final','driver_account_type','text'),
('meta_realtime_final','scheduled_routes','_text'),
('meta_realtime_final','actual_routes','_text'),
('meta_realtime_final','extra_routes','_text'),
('meta_realtime_final','delivery_assigned','int4'),
('meta_realtime_final','delivery_scanned','int4'),
('meta_realtime_final','delivery_completed','int4'),
('meta_realtime_final','delivery_impossible','int4'),
('meta_realtime_final','delivery_pdd_miss','int4'),
('meta_realtime_final','delivery_total','int4'),
('meta_realtime_final','delivery_complete_rate','numeric'),
('meta_realtime_final','return_pending','int4'),
('meta_realtime_final','return_collected','int4'),
('meta_realtime_final','return_uncollected_raw','int4'),
('meta_realtime_final','return_absent_raw','int4'),
('meta_realtime_final','return_uncollected','int4'),
('meta_realtime_final','return_total','int4'),
('meta_realtime_final','return_attempt_rate','numeric'),
('meta_realtime_final','return_collection_rate','numeric'),
('meta_realtime_final','freshbag_pending','int4'),
('meta_realtime_final','freshbag_collected','int4'),
('meta_realtime_final','freshbag_uncollected','int4'),
('meta_realtime_final','freshbag_total','int4'),
('meta_realtime_final','freshbag_attempt_rate','numeric'),
('meta_realtime_final','freshbag_collection_rate','numeric'),
('meta_realtime_final','scan_started_at','timestamp'),
('meta_realtime_final','delivery_started_at','timestamp'),
('meta_realtime_final','delivery_completed_at','timestamp'),
('meta_realtime_final','all_completed_at','timestamp'),
('meta_realtime_final','first_seen_at','timestamp'),
('meta_realtime_final','last_seen_at','timestamp'),
('meta_realtime_final','delivery_done','bool'),
('meta_realtime_final','return_done','bool'),
('meta_realtime_final','freshbag_done','bool'),
('meta_realtime_final','raw_payload','jsonb'),
('meta_realtime_final','finalized_at','timestamp'),
('meta_realtime_final','created_at','timestamp'),
('meta_realtime_final','updated_at','timestamp'),
('meta_realtime_final','fresh_delivery_assigned','int4'),
('meta_realtime_final','fresh_delivery_scanned','int4'),
('meta_realtime_final','fresh_delivery_completed','int4'),
('meta_realtime_final','fresh_delivery_impossible','int4'),
('meta_realtime_final','fresh_delivery_pdd_miss','int4'),
('meta_realtime_final','fresh_delivery_total','int4'),
('meta_realtime_final','fresh_delivery_complete_rate','numeric'),
('meta_realtime_final','meta_worker_key','text'),
('meta_realtime_final','source_camp_code','text'),
('meta_realtime_final','all_done','bool'),
('meta_realtime_final','share','bool'),
('meta_realtime_final','fresh_miss','text'),
('meta_realtime_final','dawn_miss','text'),
('meta_realtime_final','driver_pk','int8'),
('meta_realtime_final','actual_rounds','int2'),
('meta_realtime_final','expected_rounds','int2'),
('meta_realtime_final','round1_scan_started_at','timestamp'),
('meta_realtime_final','round1_delivery_started_at','timestamp'),
('meta_realtime_final','round1_completed_at','timestamp'),
('meta_realtime_final','round1_completion_detected_at','timestamp'),
('meta_realtime_final','round1_completion_method','text'),
('meta_realtime_final','round2_scan_started_at','timestamp'),
('meta_realtime_final','round2_delivery_started_at','timestamp'),
('meta_realtime_final','round2_completed_at','timestamp'),
('meta_realtime_final','round2_completion_detected_at','timestamp'),
('meta_realtime_final','round2_completion_method','text'),
('meta_realtime_final','round3_scan_started_at','timestamp'),
('meta_realtime_final','round3_delivery_started_at','timestamp'),
('meta_realtime_final','round3_completed_at','timestamp'),
('meta_realtime_final','round3_completion_detected_at','timestamp'),
('meta_realtime_final','round3_completion_method','text'),
('meta_realtime_final','completion_method','text'),
('meta_realtime_final','completion_detected_at','timestamp'),
('meta_realtime_final','work_completed_at','timestamp'))
select string_agg(e.table_name||'.'||e.column_name||': expected '||e.udt_name||', got '||coalesce(c.udt_name,'MISSING'),'; ')
into problems from expected e left join information_schema.columns c
on c.table_schema='public' and c.table_name=e.table_name and c.column_name=e.column_name
where c.udt_name is distinct from e.udt_name;
if problems is not null then raise exception 'Incompatible realtime schema: %',problems; end if;
end $$;
notify pgrst,'reload schema';
commit;
