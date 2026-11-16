-- Opzioni specialistiche per edizione, senza modificare i moduli del calendario.
CREATE TABLE IF NOT EXISTS specialist_settings (
  course_edition_id UUID PRIMARY KEY REFERENCES course_editions(id) ON DELETE CASCADE,
  is_open BOOLEAN NOT NULL DEFAULT FALSE,
  allow_changes BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS specialist_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_edition_id UUID NOT NULL REFERENCES course_editions(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  UNIQUE (id, course_edition_id)
);
CREATE INDEX IF NOT EXISTS idx_specialist_options_edition ON specialist_options(course_edition_id);

CREATE TABLE IF NOT EXISTS specialist_choices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  course_edition_id UUID NOT NULL,
  option_id UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, course_edition_id),
  FOREIGN KEY (user_id, course_edition_id) REFERENCES enrollments(user_id, course_edition_id) ON DELETE CASCADE,
  FOREIGN KEY (option_id, course_edition_id) REFERENCES specialist_options(id, course_edition_id)
);
CREATE INDEX IF NOT EXISTS idx_specialist_choices_option ON specialist_choices(option_id);
