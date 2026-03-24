-- 005_workflow.sql
-- Consensi docenti e workflow produzione contenuti

-- Consensi dei docenti per registrazione/pubblicazione lezioni
CREATE TABLE IF NOT EXISTS teacher_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  lesson_id UUID REFERENCES lessons(id) ON DELETE SET NULL,
  consent_type TEXT NOT NULL DEFAULT 'recording' CHECK (consent_type IN ('recording', 'publication', 'avatar')),
  is_granted BOOLEAN DEFAULT FALSE,
  signed_at TIMESTAMPTZ,
  document_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_teacher_consents_teacher ON teacher_consents(teacher_id);
CREATE INDEX IF NOT EXISTS idx_teacher_consents_lesson ON teacher_consents(lesson_id);

-- Workflow produzione contenuti (da registrazione a pubblicazione)
CREATE TABLE IF NOT EXISTS content_workflow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lms_lesson_id UUID NOT NULL REFERENCES lms_lessons(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'raw' CHECK (stage IN ('raw', 'transcribing', 'transcribed', 'reviewing', 'approved', 'avatar_generating', 'avatar_ready', 'published')),
  source_video_url TEXT,
  transcript_url TEXT,
  transcript_text TEXT,
  avatar_video_url TEXT,
  reviewer_notes TEXT,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_workflow_lesson ON content_workflow(lms_lesson_id);
CREATE INDEX IF NOT EXISTS idx_content_workflow_stage ON content_workflow(stage);
CREATE INDEX IF NOT EXISTS idx_content_workflow_assigned ON content_workflow(assigned_to);
