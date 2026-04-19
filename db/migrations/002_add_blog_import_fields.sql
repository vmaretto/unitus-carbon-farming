ALTER TABLE blog_posts
ADD COLUMN IF NOT EXISTS author VARCHAR(255),
ADD COLUMN IF NOT EXISTS source_module VARCHAR(100),
ADD COLUMN IF NOT EXISTS cover_image_prompt TEXT,
ADD COLUMN IF NOT EXISTS sources JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;

UPDATE blog_posts
SET sources = COALESCE(sources, '[]'::jsonb)
WHERE sources IS NULL;

UPDATE blog_posts
SET tags = COALESCE(tags, '[]'::jsonb)
WHERE tags IS NULL;
