const test = require('node:test');
const assert = require('node:assert/strict');

const apiModule = require('../api/index.js');

function findGetRoute(path) {
  return apiModule.app._router.stack.find((entry) => {
    return entry?.route?.path === path && entry.route.methods.get;
  });
}

function findRoute(path, method) {
  return apiModule.app._router.stack.find((entry) => {
    return entry?.route?.path === path && entry.route.methods[method];
  });
}

function createJsonRes() {
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

test('GET /api/resources pubblico forza solo risorse pubblicate', async () => {
  const queries = [];
  apiModule.__setPool({
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      assert.match(String(sql), /r\.is_published = true/);
      assert.doesNotMatch(String(sql), /r\.is_published = \$1/);
      assert.deepEqual(params, []);
      return { rows: [] };
    }
  });

  const layer = findGetRoute('/api/resources');
  assert.ok(layer, 'route /api/resources non trovata');

  const req = {
    method: 'GET',
    url: '/api/resources?published=false',
    query: { published: 'false' },
    headers: {}
  };
  const res = createJsonRes();

  await layer.route.stack[0].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, []);
  assert.equal(queries.length, 1);
});

test('GET /api/resources/:id pubblico non espone testo estratto', async () => {
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql);
      assert.match(statement, /WHERE id = \$1 AND is_published = true/);
      assert.doesNotMatch(statement, /extracted_text/);
      assert.doesNotMatch(statement, /extraction_metadata/);
      assert.deepEqual(params, ['resource-1']);
      return {
        rows: [{
          id: 'resource-1',
          title: 'Risorsa pubblica',
          description: 'Descrizione',
          resourceType: 'pdf',
          url: 'https://example.com/file.pdf',
          thumbnailUrl: null,
          isPublished: true
        }]
      };
    }
  });

  const layer = findGetRoute('/api/resources/:id');
  assert.ok(layer, 'route /api/resources/:id non trovata');

  const req = {
    method: 'GET',
    url: '/api/resources/resource-1',
    params: { id: 'resource-1' },
    headers: {}
  };
  const res = createJsonRes();

  await layer.route.stack[0].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, 'resource-1');
  assert.equal(Object.hasOwn(res.body, 'extractedText'), false);
  assert.equal(Object.hasOwn(res.body, 'extractionMetadata'), false);
});

test('GET /api/lms/lessons/:id espone solo materiali pubblicati agli studenti', async () => {
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();

      if (statement.startsWith('SELECT id, lms_module_id AS "moduleId", title, description')) {
        assert.deepEqual(params, ['lesson-1']);
        return {
          rows: [{
            id: 'lesson-1',
            moduleId: 'module-1',
            title: 'Lezione 1',
            description: 'Descrizione',
            videoUrl: null,
            videoProvider: null,
            durationSeconds: 3600,
            sortOrder: 1,
            isFree: false,
            isPublished: true,
            materials: [
              { type: 'document', name: 'Bozza materiale', url: 'https://example.com/draft.pdf' },
              { type: 'document', name: 'Materiale approvato', url: 'https://example.com/approved.pdf' },
              { type: 'link', name: 'Link libero', url: 'https://example.com/free' },
              { type: 'quiz', name: 'Quiz nascosto', url: 'data:application/json,{}' }
            ],
            calendarLessonId: 'calendar-1',
            createdAt: '2026-04-30T10:00:00.000Z',
            updatedAt: '2026-04-30T10:00:00.000Z'
          }]
        };
      }

      assert.match(statement, /FROM resources r/);
      assert.doesNotMatch(statement, /r\.is_published = true/);
      assert.deepEqual(params, ['calendar-1']);
      return {
        rows: [
          {
            id: 'resource-draft',
            title: 'Bozza materiale',
            url: 'https://example.com/draft.pdf',
            resourceType: 'pdf',
            description: null,
            teacherName: 'Prof. Test',
            isPublished: false,
            reviewStatus: 'pending_teacher_approval'
          },
          {
            id: 'resource-pub',
            title: 'Materiale approvato',
            url: 'https://example.com/approved.pdf',
            resourceType: 'pdf',
            description: null,
            teacherName: 'Prof. Test',
            isPublished: true,
            reviewStatus: 'teacher_approved'
          }
        ]
      };
    }
  });

  const layer = findGetRoute('/api/lms/lessons/:id');
  assert.ok(layer, 'route /api/lms/lessons/:id non trovata');

  const req = {
    method: 'GET',
    url: '/api/lms/lessons/lesson-1',
    params: { id: 'lesson-1' },
    headers: {}
  };
  const res = createJsonRes();

  await layer.route.stack[0].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, 'lesson-1');
  assert.deepEqual(res.body.materials, [
    { type: 'document', name: 'Materiale approvato', url: 'https://example.com/approved.pdf' }
  ]);
  assert.deepEqual(res.body.linkedResources, [
    {
      id: 'resource-pub',
      title: 'Materiale approvato',
      url: 'https://example.com/approved.pdf',
      resourceType: 'pdf',
      description: null,
      teacherName: 'Prof. Test',
      isPublished: true,
      reviewStatus: 'teacher_approved'
    }
  ]);
});

test('GET /api/teachers/quizzes deduplica quiz identici prima del rendering', async () => {
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      if (statement.includes('FROM information_schema.columns')) {
        const tableName = params[0];
        if (tableName === 'resources') {
          return { rows: [{ column_name: 'teacher_id' }, { column_name: 'lesson_id' }, { column_name: 'review_status' }, { column_name: 'teacher_review_notes' }, { column_name: 'teacher_reviewed_at' }] };
        }
        if (tableName === 'quizzes') {
          return { rows: [{ column_name: 'generation_report' }] };
        }
        return { rows: [] };
      }

      assert.match(statement, /SELECT DISTINCT ON \(/);
      assert.match(statement, /ORDER BY LOWER\(r\.title\)/);
      assert.deepEqual(params, ['teacher-1']);
      return {
        rows: [{
          id: 'resource-1',
          title: 'Quiz duplicato',
          description: 'Descrizione',
          url: 'data:application/json,{}',
          reviewStatus: 'pending_teacher_approval',
          reviewNotes: null,
          reviewedAt: null,
          isPublished: false,
          createdAt: '2026-04-27T08:00:00.000Z',
          updatedAt: '2026-04-27T08:00:00.000Z',
          generationReport: null,
          lessonId: 'lesson-1',
          lessonTitle: 'Lezione 1'
        }]
      };
    }
  });

  const layer = findGetRoute('/api/teachers/quizzes');
  assert.ok(layer, 'route /api/teachers/quizzes non trovata');

  const req = {
    method: 'GET',
    url: '/api/teachers/quizzes',
    query: {},
    headers: {},
    teacher: { id: 'teacher-1' }
  };
  const res = createJsonRes();

  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, 'resource-1');
});

test('PUT /api/resources/:id/request-review invia anche un materiale non quiz al docente', async () => {
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      if (statement.includes('SELECT id FROM faculty WHERE id = $1 LIMIT 1')) {
        assert.deepEqual(params, ['teacher-1']);
        return { rows: [{ id: 'teacher-1' }] };
      }
      if (statement.includes('FROM information_schema.columns')) {
        assert.deepEqual(params, ['resources']);
        return {
          rows: [
            { column_name: 'teacher_id' },
            { column_name: 'review_status' },
            { column_name: 'teacher_review_notes' },
            { column_name: 'teacher_reviewed_at' }
          ]
        };
      }

      assert.match(statement, /UPDATE resources/);
      assert.doesNotMatch(statement, /resource_type = 'quiz'/);
      assert.match(statement, /is_published = false/);
      assert.deepEqual(params, ['teacher-1', 'resource-1']);
      return {
        rows: [{
          id: 'resource-1',
          title: 'Materiale assegnato',
          resourceType: 'pdf',
          teacherId: 'teacher-1',
          isPublished: false,
          reviewStatus: 'pending_teacher_approval'
        }]
      };
    }
  });

  const layer = findRoute('/api/resources/:id/request-review', 'put');
  assert.ok(layer, 'route PUT /api/resources/:id/request-review non trovata');

  const req = {
    method: 'PUT',
    url: '/api/resources/resource-1/request-review',
    params: { id: 'resource-1' },
    body: { teacherId: 'teacher-1' },
    headers: {}
  };
  const res = createJsonRes();

  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reviewStatus, 'pending_teacher_approval');
  assert.equal(res.body.isPublished, false);
});
