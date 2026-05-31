const test = require('node:test');
const assert = require('node:assert/strict');

const apiModule = require('../api/index.js');

function findRoute(path, method = 'put') {
  return apiModule.app._router.stack.find((entry) => {
    return entry?.route?.path === path && entry.route.methods[method];
  });
}

function createRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test('PUT /api/questions/:id/assign invia una notifica email al docente', async (t) => {
  const sent = [];
  const queries = [];
  apiModule.__setPool({
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      const normalized = String(sql).replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('SELECT id, email') && normalized.includes('FROM faculty')) {
        return {
          rows: [{
            id: 'teacher-1',
            email: 'teacher@example.com',
            displayName: 'Prof. Test'
          }]
        };
      }

      if (normalized.startsWith('UPDATE student_questions')) {
        return {
          rows: [{
            id: 'question-1',
            userId: 'student-1',
            moduleId: null,
            lmsLessonId: null,
            questionText: 'Come funziona il carbon farming?',
            status: 'assigned',
            assignedTo: 'teacher-1',
            isFaq: false,
            faqCategory: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }]
        };
      }

      if (normalized.startsWith('SELECT sq.id') && normalized.includes('FROM student_questions sq')) {
        return {
          rows: [{
            id: 'question-1',
            userId: 'student-1',
            studentName: 'Mario Rossi',
            studentEmail: 'mario@example.com',
            moduleId: null,
            moduleTitle: null,
            lmsLessonId: null,
            lessonTitle: null,
            questionText: 'Come funziona il carbon farming?',
            status: 'assigned',
            assignedTo: 'teacher-1',
            assignedTeacherName: 'Prof. Test',
            isFaq: false,
            faqCategory: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }]
        };
      }

      throw new Error(`Unexpected query: ${normalized}`);
    }
  });
  apiModule.__setQuestionAssignmentEmailSender(async (payload) => {
    sent.push(payload);
    return { success: true, provider: 'test-mail' };
  });
  t.after(() => {
    apiModule.__setPool(null);
    apiModule.__setQuestionAssignmentEmailSender(null);
  });

  const layer = findRoute('/api/questions/:id/assign', 'put');
  assert.ok(layer, 'route PUT question assign non trovata');

  const res = createRes();
  await layer.route.stack[layer.route.stack.length - 1].handle({
    method: 'PUT',
    url: '/api/questions/question-1/assign',
    params: { id: 'question-1' },
    body: { teacherId: 'teacher-1' },
    headers: { host: 'unitus.test', 'x-forwarded-proto': 'https' },
    protocol: 'http',
    get(name) {
      return this.headers[String(name || '').toLowerCase()];
    }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.notification.sent, true);
  assert.equal(res.body.notification.provider, 'test-mail');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'teacher@example.com');
  assert.match(sent[0].subject, /Nuova domanda assegnata/);
  assert.match(sent[0].html, /Come funziona il carbon farming/);
  assert.match(sent[0].html, /https:\/\/unitus.test\/teachers\//);
  assert.equal(queries.length, 3);
});
