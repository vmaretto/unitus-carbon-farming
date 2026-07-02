UPDATE resources r
SET lesson_id = ll.calendar_lesson_id,
    updated_at = NOW()
FROM quizzes q
JOIN lms_lessons ll ON ll.id = q.lms_lesson_id
WHERE q.resource_id = r.id
  AND q.lms_lesson_id IS NOT NULL
  AND r.resource_type = 'quiz'
  AND r.lesson_id IS DISTINCT FROM ll.calendar_lesson_id;
