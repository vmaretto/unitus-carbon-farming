-- Sistema di questionari di feedback (sondaggi) per studenti e docenti.
--
-- Scelte di design:
--  - 1c (anonimato compromesso): le risposte sono tracciate per utente nel sistema
--    (per evitare doppia compilazione e mandare reminder), ma chi legge i risultati
--    aggregati (admin / docente) vede SOLO aggregati e commenti senza nominativo.
--  - 2b: il docente vede aggregati anonimi solo sui questionari "su di lui".
--  - 3a: tipi di domanda nel MVP = rating 1-5 e text libero.
--  - 4b: scope di una campagna = course | module | lesson | teacher.

-- 1. Survey templates
CREATE TABLE IF NOT EXISTS surveys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  target_role TEXT NOT NULL CHECK (target_role IN ('student', 'teacher')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Domande del template
CREATE TABLE IF NOT EXISTS survey_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id UUID NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  question_type TEXT NOT NULL CHECK (question_type IN ('rating', 'text')),
  is_required BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_survey_questions_survey
  ON survey_questions(survey_id, sort_order);

-- 3. Campagne (lanci): collega un survey a un pubblico
--    scope_type stabilisce a chi va, scope_id è l'eventuale id specifico:
--      - course   : scope_id = courses.id (oppure NULL = tutti i corsi)
--      - module   : scope_id = modules.id
--      - lesson   : scope_id = lessons.id (calendario)
--      - teacher  : scope_id = faculty.id (questionario "sul docente",
--                   target_role del survey deve essere 'student')
CREATE TABLE IF NOT EXISTS survey_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id UUID NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  title TEXT,                         -- titolo libero della campagna (es. "Feedback fine M1")
  scope_type TEXT NOT NULL CHECK (scope_type IN ('course', 'module', 'lesson', 'teacher')),
  scope_id UUID,                      -- nullable solo per scope_type='course'
  opens_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closes_at TIMESTAMPTZ,              -- NULL = aperta a tempo indeterminato
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_survey_campaigns_active
  ON survey_campaigns(is_active, opens_at, closes_at);

-- 4. Inviti: chi è invitato a quale campagna.
--    Uno tra user_id (studenti) e faculty_id (docenti) è valorizzato.
CREATE TABLE IF NOT EXISTS survey_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES survey_campaigns(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  faculty_id UUID REFERENCES faculty(id) ON DELETE CASCADE,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CHECK ((user_id IS NOT NULL) <> (faculty_id IS NOT NULL))
);

-- Un utente non può essere invitato due volte alla stessa campagna
CREATE UNIQUE INDEX IF NOT EXISTS idx_survey_invitations_unique_user
  ON survey_invitations(campaign_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_survey_invitations_unique_faculty
  ON survey_invitations(campaign_id, faculty_id) WHERE faculty_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_survey_invitations_user
  ON survey_invitations(user_id, completed_at) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_survey_invitations_faculty
  ON survey_invitations(faculty_id, completed_at) WHERE faculty_id IS NOT NULL;

-- 5. Risposte
CREATE TABLE IF NOT EXISTS survey_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id UUID NOT NULL REFERENCES survey_invitations(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
  rating_value INTEGER CHECK (rating_value BETWEEN 1 AND 5),
  text_value TEXT,
  answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invitation_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_survey_answers_question
  ON survey_answers(question_id);
