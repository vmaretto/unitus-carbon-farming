-- 056_network_profiles.sql
-- Profili opt-in per il network riservato del Master

CREATE TABLE IF NOT EXISTS network_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  headline TEXT,
  organization TEXT,
  role_title TEXT,
  city TEXT,
  country TEXT,
  bio TEXT,
  skills TEXT[] NOT NULL DEFAULT '{}',
  interests TEXT[] NOT NULL DEFAULT '{}',
  linkedin_url TEXT,
  contact_email TEXT,
  is_visible BOOLEAN NOT NULL DEFAULT FALSE,
  show_email BOOLEAN NOT NULL DEFAULT FALSE,
  show_linkedin BOOLEAN NOT NULL DEFAULT TRUE,
  available_for_contact BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_network_profiles_visible ON network_profiles(is_visible);
CREATE INDEX IF NOT EXISTS idx_network_profiles_skills ON network_profiles USING GIN(skills);
CREATE INDEX IF NOT EXISTS idx_network_profiles_interests ON network_profiles USING GIN(interests);
