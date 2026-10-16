-- Run on TO:NEST Supabase, NOT Maroowell.
-- Mirrors MAROOWELL meta_replace_backend_session transaction.
-- Uses existing public.meta_backend_state (id=1).
CREATE OR REPLACE FUNCTION public.meta_replace_backend_session(
  p_cookie_bundle text,
  p_cookie_jar jsonb,
  p_http_status integer DEFAULT 200
) RETURNS bigint
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
declare
  v_generation bigint;
begin
  update public.meta_backend_state
     set cookie_bundle = p_cookie_bundle,
         cookie_jar = p_cookie_jar,
         session_generation = session_generation + 1,
         session_renewed_at = now(),
         status = 'active',
         collector_paused = false,
         collector_paused_at = null,
         collector_paused_by = null,
         last_success_at = now(),
         last_http_status = p_http_status,
         last_error = null,
         updated_at = now()
   where id = 1
   returning session_generation into v_generation;
  return v_generation;
end;
$function$;
REVOKE ALL ON FUNCTION public.meta_replace_backend_session(text,jsonb,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meta_replace_backend_session(text,jsonb,integer) TO service_role;
