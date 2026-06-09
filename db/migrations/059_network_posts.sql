-- 059_network_posts.sql
-- Feed interno per post dei partecipanti nel network riservato

CREATE TABLE IF NOT EXISTS network_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  link_url TEXT,
  link_title TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'network',
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT network_posts_visibility_check CHECK (visibility IN ('network'))
);

CREATE INDEX IF NOT EXISTS idx_network_posts_feed ON network_posts(is_deleted, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_network_posts_author ON network_posts(author_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_network_posts_tags ON network_posts USING GIN(tags);
