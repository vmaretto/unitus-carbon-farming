-- Aggiunge 'remote_partial' ai tipi di presenza ammessi
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_attendance_type_check;
ALTER TABLE attendance ADD CONSTRAINT attendance_attendance_type_check
  CHECK (attendance_type IN ('in_person', 'remote_live', 'remote_partial', 'async'));
