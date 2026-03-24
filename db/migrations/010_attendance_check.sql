-- Migrazione 010: CHECK constraint su attendance per garantire almeno un riferimento lezione
-- Impedisce record con sia lesson_id che lms_lesson_id null

ALTER TABLE attendance
ADD CONSTRAINT attendance_lesson_ref_check
CHECK (lesson_id IS NOT NULL OR lms_lesson_id IS NOT NULL);
