-- Synthetic CI database only. Never execute this fixture against production.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create table public.profiles(user_id uuid primary key,email text,display_name text,role text,status text);
create table public.tonest_info(pk_id bigint primary key,person_name text,coupang_id text,camp_code text,wave text,is_resigned boolean);
grant usage on schema public,auth to anon,authenticated,service_role;
