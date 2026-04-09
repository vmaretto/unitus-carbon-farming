-- Fix schema drift for quiz_attempts when migration 003 created legacy table first.
-- Migration 012 uses CREATE TABLE IF NOT EXISTS and may be skipped on existing DBs.

ALTER TABLE quiz_attempts
  ADD COLUMN IF NOT EXISTS resource_id UUID REFERENCES resources(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS total_points INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS time_spent_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE quiz_attempts ALTER COLUMN quiz_id DROP NOT NULL;
ALTER TABLE quiz_attempts ALTER COLUMN answers SET DEFAULT '[]'::jsonb;

ALTER TABLE quiz_attempts DROP CONSTRAINT IF EXISTS quiz_or_resource;
ALTER TABLE quiz_attempts
  ADD CONSTRAINT quiz_or_resource CHECK (quiz_id IS NOT NULL OR resource_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_quiz_attempts_resource ON quiz_attempts(resource_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_completed ON quiz_attempts(completed_at);
