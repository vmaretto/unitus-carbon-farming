-- 003_progress.sql
-- Progresso lezioni, quiz, domande e tentativi

-- Progresso video per lezione LMS
CREATE TABLE IF NOT EXISTS lesson_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lms_lesson_id UUID NOT NULL REFERENCES lms_lessons(id) ON DELETE CASCADE,
  progress_percent SMALLINT DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  last_position_seconds INTEGER DEFAULT 0,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, lms_lesson_id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_progress_user ON lesson_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_lesson_progress_lesson ON lesson_progress(lms_lesson_id);

-- Quiz associati a moduli o lezioni LMS
CREATE TABLE IF NOT EXISTS quizzes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lms_module_id UUID REFERENCES lms_modules(id) ON DELETE CASCADE,
  lms_lesson_id UUID REFERENCES lms_lessons(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  passing_score SMALLINT NOT NULL DEFAULT 60 CHECK (passing_score BETWEEN 0 AND 100),
  max_attempts INTEGER DEFAULT 0,
  time_limit_minutes INTEGER,
  is_published BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (lms_module_id IS NOT NULL OR lms_lesson_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_quizzes_module ON quizzes(lms_module_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_lesson ON quizzes(lms_lesson_id);

-- Domande dei quiz
CREATE TABLE IF NOT EXISTS quiz_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  question_type TEXT NOT NULL DEFAULT 'single_choice' CHECK (question_type IN ('single_choice', 'multiple_choice', 'true_false', 'open')),
  options JSONB,
  correct_answer JSONB,
  points INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz ON quiz_questions(quiz_id);

-- Tentativi di quiz da parte degli studenti
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quiz_id UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  score SMALLINT CHECK (score BETWEEN 0 AND 100),
  passed BOOLEAN,
  answers JSONB,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user ON quiz_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz ON quiz_attempts(quiz_id);
