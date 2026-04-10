ALTER TABLE quizzes
  ADD COLUMN IF NOT EXISTS generation_report JSONB NOT NULL DEFAULT '{}'::jsonb;
