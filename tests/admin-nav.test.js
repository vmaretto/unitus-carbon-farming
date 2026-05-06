const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('il menu admin separa Area riservata / Piattaforma e Sito pubblico', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');

  assert.match(html, /Area riservata \/ Piattaforma/);
  assert.match(html, /Sito pubblico/);
  assert.match(html, /href="#attendance">Presenze</);
  assert.match(html, /href="#lms-courses">Percorsi Formativi</);
  assert.match(html, /href="#blog">Gestione blog</);
  assert.match(html, /href="#partners">Gestione partner</);
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
});

test('la lezione usa il flusso quiz-attempts e le risorse non espongono quiz', () => {
  const lessonHtml = fs.readFileSync(path.join(__dirname, '..', 'learn', 'lesson.html'), 'utf8');
  const resourcesHtml = fs.readFileSync(path.join(__dirname, '..', 'learn', 'resources.html'), 'utf8');

  assert.match(lessonHtml, /\/api\/quiz-attempts\/start/);
  assert.match(lessonHtml, /\/api\/quiz-attempts\/\$\{quizAttemptId\}\/submit/);
  assert.match(resourcesHtml, /quizSection\.style\.display = 'none'/);
  assert.match(resourcesHtml, /if \(quizList\) quizList\.innerHTML = '';/);
});
