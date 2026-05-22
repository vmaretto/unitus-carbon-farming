-- 052_admin_preview_user.sql
-- Pseudo-utente "Admin Preview" per la pagina /admin/prof-carbonio-preview.html.
--
-- Perche' serve:
-- Quando un admin (token JWT con role='admin' e senza userId) apre la pagina
-- di anteprima del widget Prof. Carbonio, il middleware requireStudentOrAdminPreview
-- in api/index.js sintetizza un req.user.userId puntando a questa riga. In questo
-- modo:
--   - le query "WHERE user_id = $1" delle route /api/tutor/* non si rompono;
--   - le sessioni e i messaggi creati in anteprima sono scope-isolati da questo
--     user_id e NON inquinano i dati degli studenti reali;
--   - la foreign key tutor_sessions.user_id -> users.id viene rispettata.
--
-- password_hash e' volutamente non valido: questa riga esiste SOLO per la FK,
-- non per consentire un login con queste credenziali.
-- role='student' cosi' eventuali filtri "WHERE users.role='student'" la includono
-- (il widget Prof. Carbonio e' rivolto agli studenti, l'admin testa quel flusso).

INSERT INTO users (
  id,
  email,
  password_hash,
  first_name,
  last_name,
  role,
  is_active
)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'admin-preview@carbonfarmingmaster.local',
  'NO_LOGIN_ADMIN_PREVIEW',
  'Admin',
  'Preview',
  'student',
  TRUE
)
ON CONFLICT (id) DO NOTHING;
