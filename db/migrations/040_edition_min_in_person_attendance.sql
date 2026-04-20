ALTER TABLE course_editions
ADD COLUMN IF NOT EXISTS minimum_in_person_attendance_ratio NUMERIC(5,4) DEFAULT 0.7;

UPDATE course_editions
SET minimum_in_person_attendance_ratio = 0.7
WHERE minimum_in_person_attendance_ratio IS NULL OR minimum_in_person_attendance_ratio <= 0;
