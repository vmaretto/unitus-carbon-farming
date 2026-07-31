-- 071_project_tutor_requests.sql
-- Richieste di tutoraggio tra studenti, docenti e referenti ospiti.

CREATE TABLE IF NOT EXISTS project_tutor_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES network_opportunities(id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  request_type TEXT NOT NULL CHECK (request_type IN ('student_tutor', 'teacher_tutor')),
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (opportunity_id, teacher_id, request_type)
);

CREATE INDEX IF NOT EXISTS idx_project_tutor_requests_teacher
  ON project_tutor_requests(teacher_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_tutor_requests_project
  ON project_tutor_requests(opportunity_id, status, created_at DESC);
