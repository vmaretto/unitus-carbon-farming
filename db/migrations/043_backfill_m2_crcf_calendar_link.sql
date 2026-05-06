-- Backfill the M2 CRCF lesson that was left without a calendar link.
-- Keep this narrow so it only touches the known legacy row.

UPDATE lms_lessons lms
SET calendar_lesson_id = cal.id
FROM lessons cal
WHERE lms.calendar_lesson_id IS NULL
  AND LOWER(TRIM(lms.title)) = LOWER(TRIM(cal.title))
  AND LOWER(lms.title) LIKE '%regolamento europeo 2024/3012%'
  AND LOWER(lms.title) LIKE '%certificaz%'
  AND cal.start_datetime::date = DATE '2026-04-30';
