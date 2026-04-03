-- Add teacher and lesson association to resources
ALTER TABLE resources ADD COLUMN IF NOT EXISTS teacher_id UUID REFERENCES faculty(id) ON DELETE SET NULL;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS lesson_id UUID REFERENCES lessons(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_resources_teacher ON resources(teacher_id);
CREATE INDEX IF NOT EXISTS idx_resources_lesson ON resources(lesson_id);
