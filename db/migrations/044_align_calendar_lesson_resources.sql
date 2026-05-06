-- Align calendar-linked resources to the LMS lesson calendar link when titles match.
-- This fixes legacy rows where the resource was approved correctly but attached
-- to a different calendar lesson than the LMS lesson shown to students.

UPDATE resources r
SET lesson_id = ll.calendar_lesson_id,
    updated_at = NOW()
FROM lms_lessons ll
WHERE ll.calendar_lesson_id IS NOT NULL
  AND COALESCE(r.source, 'admin') = 'calendar_lesson'
  AND LOWER(TRIM(r.title)) = LOWER(TRIM(ll.title))
  AND r.lesson_id IS DISTINCT FROM ll.calendar_lesson_id;
