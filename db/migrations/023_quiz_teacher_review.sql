-- Teacher review workflow for quiz resources
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (review_status IN ('draft', 'pending_teacher_approval', 'teacher_approved', 'teacher_rejected')),
  ADD COLUMN IF NOT EXISTS teacher_review_notes TEXT,
  ADD COLUMN IF NOT EXISTS teacher_reviewed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_resources_review_status ON resources(review_status);
