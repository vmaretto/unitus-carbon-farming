UPDATE faculty
SET email = LOWER(TRIM(email))
WHERE email IS NOT NULL;

DROP INDEX IF EXISTS idx_faculty_email;

CREATE UNIQUE INDEX IF NOT EXISTS idx_faculty_email_lower
  ON faculty (LOWER(email))
  WHERE email IS NOT NULL;
