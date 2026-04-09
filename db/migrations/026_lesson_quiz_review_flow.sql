-- Lesson quizzes should be managed through the lesson admin flow and
-- teacher approval, not duplicated as public lesson materials/resources.

-- 1. Stop surfacing lesson quizzes as linked lesson resources.
UPDATE resources r
SET lesson_id = NULL,
    updated_at = NOW()
FROM quizzes q
WHERE q.resource_id = r.id
  AND q.lms_lesson_id IS NOT NULL
  AND r.lesson_id IS NOT NULL;

-- 2. Remove legacy lesson-material quiz entries that duplicated the central quiz block.
UPDATE lms_lessons ll
SET materials = cleaned.materials,
    updated_at = NOW()
FROM (
  SELECT
    l.id,
    COALESCE(
      jsonb_agg(item) FILTER (
        WHERE NOT (
          COALESCE(item->>'type', '') = 'quiz'
          OR item ? 'quizId'
          OR COALESCE(item->>'url', '') LIKE '/learn/quiz.html?quizId=%'
        )
      ),
      '[]'::jsonb
    ) AS materials
  FROM lms_lessons l
  LEFT JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(COALESCE(l.materials, '[]'::jsonb)) = 'array'
        THEN COALESCE(l.materials, '[]'::jsonb)
      ELSE '[]'::jsonb
    END
  ) AS item ON TRUE
  GROUP BY l.id
) AS cleaned
WHERE cleaned.id = ll.id;
