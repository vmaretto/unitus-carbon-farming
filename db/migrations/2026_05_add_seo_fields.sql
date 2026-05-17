ALTER TABLE blog_posts
  ADD COLUMN IF NOT EXISTS seo_title        VARCHAR(80),
  ADD COLUMN IF NOT EXISTS meta_description VARCHAR(200),
  ADD COLUMN IF NOT EXISTS focus_keyword    VARCHAR(120),
  ADD COLUMN IF NOT EXISTS pillar_slug      VARCHAR(120),
  ADD COLUMN IF NOT EXISTS cover_alt        VARCHAR(200),
  ADD COLUMN IF NOT EXISTS internal_links   JSONB,
  ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_blog_posts_focus_keyword ON blog_posts (focus_keyword);
CREATE INDEX IF NOT EXISTS idx_blog_posts_pillar_slug   ON blog_posts (pillar_slug);

CREATE TABLE IF NOT EXISTS pillar_pages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             VARCHAR(120) UNIQUE NOT NULL,
  title            TEXT NOT NULL,
  seo_title        VARCHAR(80),
  meta_description VARCHAR(200),
  focus_keyword    VARCHAR(120),
  body_html        TEXT NOT NULL,
  cover_image_url  TEXT,
  cover_alt        VARCHAR(200),
  is_published     BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
