ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS extracted_text TEXT,
  ADD COLUMN IF NOT EXISTS extraction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending', 'ready', 'failed', 'unavailable')),
  ADD COLUMN IF NOT EXISTS extraction_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_resources_extraction_status
  ON resources(extraction_status);
