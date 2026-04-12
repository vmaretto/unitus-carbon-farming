CREATE UNIQUE INDEX IF NOT EXISTS idx_teacher_doc_signatures_doc_faculty_unique
  ON teacher_document_signatures(document_id, faculty_id);
