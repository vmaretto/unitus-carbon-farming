-- 057_network_profile_media.sql
-- Campi aggiuntivi per profili network in stile professionale

ALTER TABLE network_profiles
  ADD COLUMN IF NOT EXISTS profile_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT,
  ADD COLUMN IF NOT EXISTS collaboration_goals TEXT,
  ADD COLUMN IF NOT EXISTS experience JSONB,
  ADD COLUMN IF NOT EXISTS featured_links JSONB;

UPDATE network_profiles
SET experience = '[]'::jsonb
WHERE experience IS NULL;

UPDATE network_profiles
SET featured_links = '[]'::jsonb
WHERE featured_links IS NULL;

ALTER TABLE network_profiles
  ALTER COLUMN experience SET DEFAULT '[]'::jsonb,
  ALTER COLUMN featured_links SET DEFAULT '[]'::jsonb;
