CREATE TABLE IF NOT EXISTS resource_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  first_viewed_at TIMESTAMPTZ DEFAULT NOW(),
  view_count INTEGER DEFAULT 1,
  UNIQUE(user_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_views_user ON resource_views(user_id);
