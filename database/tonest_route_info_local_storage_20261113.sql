-- TO:NEST route information: local-first persistence (2026-11-13)
-- Existing positive IDs remain unchanged and linked to MAROOWELL.
-- New rows receive negative local IDs. No live route rows are rewritten except
-- an idempotent legacy linkage update.
BEGIN;
CREATE SEQUENCE IF NOT EXISTS public.tonest_route_info_local_id_seq
  AS bigint INCREMENT BY -1 MINVALUE -9223372036854775807 MAXVALUE -1
  START WITH -1 NO CYCLE;
ALTER SEQUENCE public.tonest_route_info_local_id_seq OWNED BY public.tonest_route_info.id;
ALTER TABLE public.tonest_route_info
  ALTER COLUMN id SET DEFAULT nextval('public.tonest_route_info_local_id_seq'::regclass);
ALTER TABLE public.tonest_route_info
  ADD COLUMN IF NOT EXISTS maroowell_subsubroute_id bigint,
  ADD COLUMN IF NOT EXISTS maroowell_sync_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS maroowell_sync_error text;
UPDATE public.tonest_route_info
 SET maroowell_subsubroute_id=id,maroowell_sync_status='synced',maroowell_sync_error=NULL
 WHERE id>0 AND maroowell_subsubroute_id IS NULL;
DO $mig$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid='public.tonest_route_info'::regclass
                  AND conname='tonest_route_info_sync_status_check') THEN
  ALTER TABLE public.tonest_route_info ADD CONSTRAINT tonest_route_info_sync_status_check
    CHECK (maroowell_sync_status IN ('pending','synced','error'));
 END IF;
END $mig$;
CREATE UNIQUE INDEX IF NOT EXISTS tonest_route_info_maroowell_id_uq
 ON public.tonest_route_info(maroowell_subsubroute_id)
 WHERE maroowell_subsubroute_id IS NOT NULL;
COMMENT ON COLUMN public.tonest_route_info.maroowell_subsubroute_id
 IS 'Optional MAROOWELL subsubroutes PK; local IDs may be negative.';
COMMENT ON COLUMN public.tonest_route_info.maroowell_sync_status
 IS 'Local save state: pending/synced/error; external sync never blocks local save.';
COMMIT;
NOTIFY pgrst,'reload schema';
