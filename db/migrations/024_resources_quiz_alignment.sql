-- Align resources schema with quiz review workflow.
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS teacher_id UUID REFERENCES faculty(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lesson_id UUID REFERENCES lessons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (review_status IN ('draft', 'pending_teacher_approval', 'teacher_approved', 'teacher_rejected')),
  ADD COLUMN IF NOT EXISTS teacher_review_notes TEXT,
  ADD COLUMN IF NOT EXISTS teacher_reviewed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_resources_teacher ON resources(teacher_id);
CREATE INDEX IF NOT EXISTS idx_resources_lesson ON resources(lesson_id);
CREATE INDEX IF NOT EXISTS idx_resources_review_status ON resources(review_status);

DO $$
DECLARE
  check_name TEXT;
BEGIN
  SELECT con.conname
  INTO check_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'resources'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%resource_type%'
  LIMIT 1;

  IF check_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.resources DROP CONSTRAINT %I', check_name);
  END IF;
END $$;

ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_resource_type_check;

ALTER TABLE resources
  ADD CONSTRAINT resources_resource_type_check
  CHECK (resource_type IN ('video', 'pdf', 'document', 'audio', 'link', 'quiz'));
