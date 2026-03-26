-- Tabella risorse per materiali didattici
CREATE TABLE IF NOT EXISTS resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('video', 'pdf', 'document', 'audio', 'link')),
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  file_size_bytes BIGINT,
  sort_order INTEGER DEFAULT 0,
  is_published BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(resource_type);
CREATE INDEX IF NOT EXISTS idx_resources_published ON resources(is_published);
