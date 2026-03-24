-- 008_attendance_type.sql
-- Aggiunge tipo presenza, metodo auto_tracking, e supporto lms_lesson_id

-- Tipo di presenza
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS attendance_type TEXT DEFAULT 'in_person'
    CHECK (attendance_type IN ('in_person', 'remote_live', 'async'));

-- Aggiorna vincolo method per includere auto_tracking
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_method_check;
ALTER TABLE attendance ADD CONSTRAINT attendance_method_check
  CHECK (method IN ('qr', 'pin', 'csv_import', 'teams_auto', 'manual', 'auto_tracking'));

-- Collegamento opzionale a lms_lessons (per presenze async da completamento lezione LMS)
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS lms_lesson_id UUID REFERENCES lms_lessons(id) ON DELETE SET NULL;

-- Rendi lesson_id nullable (per presenze async che non hanno lezione calendario)
ALTER TABLE attendance ALTER COLUMN lesson_id DROP NOT NULL;

-- Indice per lms_lesson_id
CREATE INDEX IF NOT EXISTS idx_attendance_lms_lesson ON attendance(lms_lesson_id);

-- Vincolo unicità per presenze async (un solo record per user+lms_lesson)
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_user_lms_lesson
  ON attendance(user_id, lms_lesson_id) WHERE lms_lesson_id IS NOT NULL;
