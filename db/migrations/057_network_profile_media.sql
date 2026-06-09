-- 057_network_profile_media.sql
-- Campi aggiuntivi per profili network in stile professionale

ALTER TABLE network_profiles
  ADD COLUMN IF NOT EXISTS profile_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT,
  ADD COLUMN IF NOT EXISTS collaboration_goals TEXT,
  ADD COLUMN IF NOT EXISTS experience JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS featured_links JSONB NOT NULL DEFAULT '[]'::jsonb;
