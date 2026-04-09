ALTER TABLE quizzes
  ADD COLUMN IF NOT EXISTS resource_id UUID REFERENCES resources(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quizzes_resource_id_unique
  ON quizzes(resource_id)
  WHERE resource_id IS NOT NULL;
