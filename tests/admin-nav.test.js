const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('il menu admin separa Area riservata / Piattaforma e Sito pubblico', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');

  assert.match(html, /class="admin-sidebar"/);
  assert.match(html, /class="mobile-header"/);
  assert.match(html, /Piattaforma LMS/);
  assert.match(html, /Gestione Corsi/);
  assert.match(html, /Sito Pubblico/);
  assert.match(html, /href="#attendance" data-section="attendance">✅ Presenze</);
  assert.match(html, /href="#student-progress" data-section="student-progress">📈 Progressi studenti</);
  assert.match(html, /href="#lms-courses" data-section="lms-courses">🎓 Percorsi formativi</);
  assert.match(html, /href="#conference-registrations" data-section="conference-registrations">📨 Conferenza 26\/5</);
  assert.match(html, /Apri Resend/);
  assert.match(html, /Apri Brevo/);
  assert.match(html, /conference-registrations-import-form/);
  assert.match(html, /Importa da Excel/);
  assert.match(html, /<th>Fonte<\/th>/);
  assert.match(html, /href="#blog" data-section="blog">📝 Blog</);
  assert.match(html, /href="#partners" data-section="partners">🤝 Partner</);
  assert.match(html, /<th>Ruolo<\/th>/);
  assert.match(html, /👁️ Ospite \(solo consultazione\)/);
  assert.match(html, /Domande inviate/);
  assert.match(html, /Feedback ricevuti/);
  assert.doesNotMatch(html, /Domande \/ feedback/);
  assert.doesNotMatch(html, /slice\(0, 8\)/);
  assert.equal((html.match(/<section id="/g) || []).length, 16);
});

test('la sezione LMS admin non contiene debug temporanei e usa cache lezioni per modulo', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');

  assert.match(html, /lmsLessonsByModule/);
  assert.match(html, /async function ensureAllLessonsCache\(forceRefresh = false\)/);
  assert.match(html, /data-refresh-calendar-lessons/);
  assert.match(html, /await ensureAllLessonsCache\(forceRefresh\);/);
  assert.doesNotMatch(html, /🐛 DEBUG|CHIAMANDO: \/api\/materials\/upload|Edit clicked, id:|Found enrollment:/);
  assert.match(html, /Quiz manuale della lezione/);
  assert.match(html, /data-manual-lms-quiz-save/);
  assert.match(html, /pubblicata direttamente/);
  assert.match(html, /function handleHashRoute\(\)/);
  assert.match(html, /window\.addEventListener\('hashchange', handleHashRoute\)/);
  assert.match(html, /document\.querySelectorAll\('\.admin-main section'\)/);
});

test('la lezione usa il flusso quiz-attempts e le risorse non espongono quiz', () => {
  const lessonHtml = fs.readFileSync(path.join(__dirname, '..', 'learn', 'lesson.html'), 'utf8');
  const courseHtml = fs.readFileSync(path.join(__dirname, '..', 'learn', 'course.html'), 'utf8');
  const resourcesHtml = fs.readFileSync(path.join(__dirname, '..', 'learn', 'resources.html'), 'utf8');

  assert.match(lessonHtml, /\/api\/quiz-attempts\/start/);
  assert.match(lessonHtml, /\/api\/quiz-attempts\/\$\{quizAttemptId\}\/submit/);
  assert.match(lessonHtml, /let quizAnswers = \[\];/);
  assert.match(lessonHtml, /quizAnswers = Array\.isArray\(quiz\.questions\) \? quiz\.questions\.map\(\(\) => null\) : \[\];/);
  assert.match(lessonHtml, /encodeURIComponent\(JSON\.stringify\(opt\)\)/);
  assert.match(lessonHtml, /input\.addEventListener\('change', \(\) =>/);
  assert.match(lessonHtml, /normalizeQuizAnswerForSubmit\(quizAnswers\[index\], q\.questionType\)/);
  assert.match(lessonHtml, /resultArea\.scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\);/);
  assert.match(lessonHtml, /id="quiz-review-area"/);
  assert.match(lessonHtml, /renderQuizReview\(result\)/);
  assert.match(lessonHtml, /formatAttemptDate/);
  assert.match(lessonHtml, /Presenza in aula o live registrata/);
  assert.match(courseHtml, /document\.documentElement\.classList\.add\('guest-view'\)/);
  assert.match(courseHtml, /html\.guest-view \.progress-bar,/);
  assert.doesNotMatch(courseHtml, /Materiali didattici/);
  assert.match(resourcesHtml, /quizSection\.style\.display = 'none'/);
  assert.match(resourcesHtml, /if \(quizList\) quizList\.innerHTML = '';/);
  assert.match(resourcesHtml, /Materiali delle lezioni/);
});
