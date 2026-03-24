-- 009_workflow_stages.sql
-- Aggiorna stage del workflow e aggiunge review_token per accesso docenti

-- Aggiorna vincolo stage con i nomi corretti
ALTER TABLE content_workflow DROP CONSTRAINT IF EXISTS content_workflow_stage_check;
ALTER TABLE content_workflow ADD CONSTRAINT content_workflow_stage_check
  CHECK (stage IN ('uploaded', 'transcribing', 'transcript_ready', 'teacher_review_transcript', 'avatar_rendering', 'teacher_review_video', 'published'));

-- Aggiorna valori esistenti al nuovo schema
UPDATE content_workflow SET stage = 'uploaded' WHERE stage = 'raw';
UPDATE content_workflow SET stage = 'transcript_ready' WHERE stage = 'transcribed';
UPDATE content_workflow SET stage = 'teacher_review_transcript' WHERE stage = 'reviewing';
UPDATE content_workflow SET stage = 'avatar_rendering' WHERE stage = 'approved';
UPDATE content_workflow SET stage = 'teacher_review_video' WHERE stage = 'avatar_ready';
UPDATE content_workflow SET stage = 'avatar_rendering' WHERE stage = 'avatar_generating';

-- Token per accesso revisione docente (senza login)
ALTER TABLE content_workflow
  ADD COLUMN IF NOT EXISTS review_token TEXT,
  ADD COLUMN IF NOT EXISTS review_token_expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_workflow_review_token
  ON content_workflow(review_token) WHERE review_token IS NOT NULL;
