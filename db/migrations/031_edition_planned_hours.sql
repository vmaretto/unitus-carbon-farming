ALTER TABLE course_editions
ADD COLUMN IF NOT EXISTS total_planned_hours INTEGER DEFAULT 432;

UPDATE course_editions
SET total_planned_hours = 432
WHERE total_planned_hours IS NULL OR total_planned_hours <= 0;
