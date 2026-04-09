-- 1. Aggiungere colonne mancanti a faculty (da teachers)
ALTER TABLE faculty ADD COLUMN IF NOT EXISTS first_name VARCHAR(255);
ALTER TABLE faculty ADD COLUMN IF NOT EXISTS last_name VARCHAR(255);
ALTER TABLE faculty ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE faculty ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- 2. Popolare first_name e last_name dai nomi esistenti in faculty
UPDATE faculty SET
  last_name = CASE
    WHEN name LIKE '% %' THEN split_part(name, ' ', array_length(string_to_array(name, ' '), 1))
    ELSE name
  END,
  first_name = CASE
    WHEN name LIKE '% %' THEN rtrim(left(name, length(name) - length(split_part(name, ' ', array_length(string_to_array(name, ' '), 1)))))
    ELSE ''
  END
WHERE first_name IS NULL;

-- 3. Ricreare teacher_documents, teacher_document_signatures, materials_pending con FK a faculty
DROP TABLE IF EXISTS teacher_document_signatures CASCADE;
DROP TABLE IF EXISTS teacher_documents CASCADE;
DROP TABLE IF EXISTS materials_pending CASCADE;

CREATE TABLE IF NOT EXISTS teacher_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  faculty_id UUID NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type VARCHAR(50) DEFAULT 'liberatoria',
  content TEXT,
  pdf_url TEXT,
  status VARCHAR(50) DEFAULT 'draft',
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teacher_document_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES teacher_documents(id) ON DELETE CASCADE,
  faculty_id UUID NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  signature_data TEXT,
  signed_at TIMESTAMPTZ,
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS materials_pending (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  faculty_id UUID NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  lesson_id UUID REFERENCES lessons(id) ON DELETE SET NULL,
  file_url TEXT NOT NULL,
  file_name TEXT,
  file_type TEXT,
  status VARCHAR(50) DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Droppa la tabella teachers
DROP TABLE IF EXISTS teachers CASCADE;

-- 5. Aggiungi indice unico su email di faculty (per login docenti)
CREATE UNIQUE INDEX IF NOT EXISTS idx_faculty_email ON faculty(email) WHERE email IS NOT NULL;
