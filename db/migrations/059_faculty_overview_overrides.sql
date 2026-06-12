-- 059_faculty_overview_overrides.sql
-- Override manuali del riepilogo faculty senza toccare la tabella faculty

CREATE TABLE IF NOT EXISTS faculty_overview_overrides (
  faculty_id UUID PRIMARY KEY REFERENCES faculty(id) ON DELETE CASCADE,
  appointment_received_manual BOOLEAN,
  received_hours NUMERIC(6, 1),
  notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
