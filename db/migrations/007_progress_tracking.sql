-- 007_progress_tracking.sql
-- Aggiunge time_spent_seconds e watched_segments a lesson_progress per tracking reale

ALTER TABLE lesson_progress
  ADD COLUMN IF NOT EXISTS time_spent_seconds INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS watched_segments JSONB DEFAULT '[]';

-- Aggiunge asset_type 'recording_final' a lesson_assets
ALTER TABLE lesson_assets DROP CONSTRAINT IF EXISTS lesson_assets_asset_type_check;
ALTER TABLE lesson_assets ADD CONSTRAINT lesson_assets_asset_type_check
  CHECK (asset_type IN ('pdf', 'slide', 'link', 'file', 'recording_final', 'other'));
