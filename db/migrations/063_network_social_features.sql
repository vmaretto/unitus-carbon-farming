-- Estende il network con media post, follow, like, commenti e notifiche.

ALTER TABLE network_posts
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS media_alt TEXT,
  ADD COLUMN IF NOT EXISTS link_preview_title TEXT,
  ADD COLUMN IF NOT EXISTS link_preview_description TEXT,
  ADD COLUMN IF NOT EXISTS link_preview_image_url TEXT,
  ADD COLUMN IF NOT EXISTS link_preview_site_name TEXT;

CREATE INDEX IF NOT EXISTS idx_network_posts_media ON network_posts(author_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS network_follows (
  follower_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_user_id, following_user_id),
  CONSTRAINT network_follows_no_self CHECK (follower_user_id <> following_user_id)
);

CREATE TABLE IF NOT EXISTS network_post_likes (
  post_id UUID NOT NULL REFERENCES network_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS network_post_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES network_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_network_post_comments_post_created
  ON network_post_comments(post_id, created_at DESC);

CREATE TABLE IF NOT EXISTS network_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_network_notifications_user_read
  ON network_notifications(user_id, is_read, created_at DESC);
