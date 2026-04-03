-- Link LMS lessons to calendar lessons
ALTER TABLE lms_lessons ADD COLUMN IF NOT EXISTS calendar_lesson_id UUID REFERENCES lessons(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_lms_lessons_calendar ON lms_lessons(calendar_lesson_id);

-- Auto-populate based on matching titles
UPDATE lms_lessons lms
SET calendar_lesson_id = l.id
FROM lessons l
WHERE LOWER(TRIM(lms.title)) = LOWER(TRIM(l.title))
AND lms.calendar_lesson_id IS NULL;
