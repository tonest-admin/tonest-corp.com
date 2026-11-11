-- TO:NEST: route information shift classifier (2026-11-11).
-- Existing routes deliberately remain NULL (미지정); no live schedule changes.
BEGIN;
ALTER TABLE public.tonest_route_info ADD COLUMN IF NOT EXISTS wave text;
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.tonest_route_info'::regclass
      AND conname='tonest_route_info_wave_check'
  ) THEN
    ALTER TABLE public.tonest_route_info
      ADD CONSTRAINT tonest_route_info_wave_check
      CHECK (wave IS NULL OR wave IN ('WAVE1','WAVE2'));
  END IF;
END $mig$;
COMMENT ON COLUMN public.tonest_route_info.wave IS
  'WAVE1=야간, WAVE2=주간, NULL=미지정 (기존 라우트 호환)';
COMMIT;
NOTIFY pgrst, 'reload schema';
