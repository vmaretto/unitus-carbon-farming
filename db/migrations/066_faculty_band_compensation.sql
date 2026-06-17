-- Faculty band (academic rank) and pro bono flag
ALTER TABLE faculty
  ADD COLUMN IF NOT EXISTS band TEXT;

ALTER TABLE faculty
  ADD COLUMN IF NOT EXISTS is_pro_bono BOOLEAN NOT NULL DEFAULT FALSE;
