-- NOTA: Questa migrazione potrebbe richiedere esecuzione manuale su Neon
-- se il deploy Vercel non la esegue automaticamente.

-- 1. Aggiungere campi LMS a modules
ALTER TABLE modules ADD COLUMN IF NOT EXISTS course_id UUID REFERENCES courses(id) ON DELETE SET NULL;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT true;

-- 2. Impostare course_id per tutti i moduli esistenti (c'è un solo corso)
UPDATE modules SET course_id = 'ac9ecd8a-78b6-40cd-8340-61e6642ee1e9' WHERE course_id IS NULL;

-- 3. Spostare le lms_lessons dal vecchio lms_module "Modulo 1" al modules "M1"
UPDATE lms_lessons SET lms_module_id = '36e8db24-6a89-4993-b4cd-03b14c01b06b' WHERE lms_module_id = 'a433b476-b2b2-41e3-9973-01a4a7321a60';

-- 4. Spostare i quiz dal vecchio lms_module al modules "M1"
UPDATE quizzes SET lms_module_id = '36e8db24-6a89-4993-b4cd-03b14c01b06b' WHERE lms_module_id = 'a433b476-b2b2-41e3-9973-01a4a7321a60';

-- 5. Aggiornare la FK di lms_lessons per puntare a modules
ALTER TABLE lms_lessons DROP CONSTRAINT IF EXISTS lms_lessons_lms_module_id_fkey;
ALTER TABLE lms_lessons ADD CONSTRAINT lms_lessons_lms_module_id_fkey FOREIGN KEY (lms_module_id) REFERENCES modules(id) ON DELETE SET NULL;

-- 6. Aggiornare la FK di quizzes per puntare a modules
ALTER TABLE quizzes DROP CONSTRAINT IF EXISTS quizzes_lms_module_id_fkey;
ALTER TABLE quizzes ADD CONSTRAINT quizzes_lms_module_id_fkey FOREIGN KEY (lms_module_id) REFERENCES modules(id) ON DELETE SET NULL;

-- 7. Droppare lms_modules
DROP TABLE IF EXISTS lms_modules CASCADE;
