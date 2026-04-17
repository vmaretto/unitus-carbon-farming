-- Aggiunge ruolo guest alla tabella users
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('student', 'teacher', 'admin', 'guest'));

-- Aggiunge ruolo guest alla tabella student_questions (author_role)
ALTER TABLE student_questions DROP CONSTRAINT IF EXISTS student_questions_author_role_check;
ALTER TABLE student_questions ADD CONSTRAINT student_questions_author_role_check
  CHECK (author_role IN ('admin', 'teacher', 'student', 'guest'));
