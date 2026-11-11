-- TO:NEST only. Existing tonest_schedule and all realtime tables are unchanged.
-- This stores the actual META upload completion date, matching MAROOWELL.
BEGIN;
CREATE TABLE IF NOT EXISTS public.tonest_schedule_update_status (
  camp text NOT NULL,
  wave text NOT NULL CHECK (wave IN ('WAVE1','WAVE2')),
  actual_update_date date,
  fake_update_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (camp,wave)
);
ALTER TABLE public.tonest_schedule_update_status ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tonest_schedule_update_status FROM anon;
GRANT SELECT ON public.tonest_schedule_update_status TO authenticated;
GRANT ALL ON public.tonest_schedule_update_status TO service_role;
DROP POLICY IF EXISTS tonest_schedule_update_status_read ON public.tonest_schedule_update_status;
CREATE POLICY tonest_schedule_update_status_read ON public.tonest_schedule_update_status
  FOR SELECT TO authenticated USING ((SELECT public.tn_can_manage_schedule()));
COMMIT;
NOTIFY pgrst, 'reload schema';
