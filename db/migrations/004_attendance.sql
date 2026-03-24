-- 004_attendance.sql
-- Sistema presenze: registrazioni e codici di check-in

-- Registrazioni di presenza (legate alle lezioni del calendario esistente)
CREATE TABLE IF NOT EXISTS attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  check_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  check_out_at TIMESTAMPTZ,
  method TEXT NOT NULL DEFAULT 'manual' CHECK (method IN ('qr', 'pin', 'csv_import', 'teams_auto', 'manual')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, lesson_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_user ON attendance(user_id);
CREATE INDEX IF NOT EXISTS idx_attendance_lesson ON attendance(lesson_id);

-- Codici temporanei per check-in (QR code o PIN)
CREATE TABLE IF NOT EXISTS attendance_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  code_type TEXT NOT NULL DEFAULT 'pin' CHECK (code_type IN ('qr', 'pin')),
  expires_at TIMESTAMPTZ NOT NULL,
  is_used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attendance_codes_lesson ON attendance_codes(lesson_id);
CREATE INDEX IF NOT EXISTS idx_attendance_codes_code ON attendance_codes(code);
