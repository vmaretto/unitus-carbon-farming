CREATE TABLE IF NOT EXISTS student_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id UUID REFERENCES modules(id) ON DELETE SET NULL,
  lms_lesson_id UUID REFERENCES lms_lessons(id) ON DELETE SET NULL,
  question_text TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'answered', 'promoted_faq')),
  assigned_to UUID REFERENCES faculty(id) ON DELETE SET NULL,
  is_faq BOOLEAN DEFAULT false,
  faq_category VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS question_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES student_questions(id) ON DELETE CASCADE,
  author_id UUID NOT NULL,
  author_role VARCHAR(20) NOT NULL CHECK (author_role IN ('admin', 'teacher', 'student')),
  reply_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_questions_user ON student_questions(user_id);
CREATE INDEX IF NOT EXISTS idx_questions_status ON student_questions(status);
CREATE INDEX IF NOT EXISTS idx_questions_assigned ON student_questions(assigned_to);
CREATE INDEX IF NOT EXISTS idx_replies_question ON question_replies(question_id);
