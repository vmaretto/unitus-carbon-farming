ALTER TABLE teacher_document_signatures
  ADD COLUMN IF NOT EXISTS consent_given BOOLEAN,
  ADD COLUMN IF NOT EXISTS signature_image TEXT,
  ADD COLUMN IF NOT EXISTS signature_method VARCHAR(50),
  ADD COLUMN IF NOT EXISTS signer_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS signer_surname VARCHAR(255),
  ADD COLUMN IF NOT EXISTS user_agent TEXT;

UPDATE teacher_document_signatures
SET
  consent_given = COALESCE(consent_given, NULLIF((signature_data::jsonb ->> 'consentGiven'), '')::boolean),
  signature_image = COALESCE(signature_image, signature_data::jsonb ->> 'signatureImage'),
  signature_method = COALESCE(signature_method, signature_data::jsonb ->> 'signatureMethod'),
  signer_name = COALESCE(signer_name, signature_data::jsonb ->> 'signerName'),
  signer_surname = COALESCE(signer_surname, signature_data::jsonb ->> 'signerSurname'),
  user_agent = COALESCE(user_agent, signature_data::jsonb ->> 'userAgent')
WHERE signature_data IS NOT NULL
  AND signature_data LIKE '{%';

CREATE INDEX IF NOT EXISTS idx_teacher_doc_sigs_consent
  ON teacher_document_signatures(consent_given);
