ALTER TABLE resources ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'admin';
ALTER TABLE resources ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_source_check;
ALTER TABLE resources ADD CONSTRAINT resources_source_check
  CHECK (source IN ('admin', 'teacher', 'calendar_lesson', 'ai_generated'));

CREATE INDEX IF NOT EXISTS idx_resources_source ON resources(source);
CREATE INDEX IF NOT EXISTS idx_resources_lesson ON resources(lesson_id);
CREATE INDEX IF NOT EXISTS idx_resources_tags ON resources USING GIN(tags);

UPDATE resources
SET source = 'calendar_lesson'
WHERE teacher_id IS NOT NULL
  AND lesson_id IS NOT NULL
  AND source = 'admin';

UPDATE resources
SET source = 'teacher'
WHERE teacher_id IS NOT NULL
  AND lesson_id IS NULL
  AND source = 'admin';
