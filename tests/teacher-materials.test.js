const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTeacherLessonAccessQuery,
  buildMaterialsPendingInsertPayload,
  getTeacherMaterialResourceTitle
} = require('../api/teacher-materials');
const apiModule = require('../api/index.js');

function findRouteHandler(path, method) {
  const layer = apiModule.app._router.stack.find((entry) => entry?.route?.path === path && entry.route.methods[method]);
  assert.ok(layer, `route ${method.toUpperCase()} ${path} non trovata`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    }
  };
}

class FakeTeacherMaterialsPool {
  constructor() {
    this.pendingRows = [
      {
        id: 'pending-1',
        title: 'Slide seminario',
        description: 'Versione aggiornata',
        file_url: 'https://cdn.example.com/slide-seminario.pdf',
        file_name: 'slide-seminario.pdf',
        file_type: 'application/pdf',
        status: 'pending',
        notes: null,
        created_at: '2026-04-24T08:00:00.000Z',
        source: 'upload'
      },
      {
        id: 'rejected-1',
        title: 'Bozza materiale',
        description: null,
        file_url: 'https://cdn.example.com/bozza.pdf',
        file_name: 'bozza.pdf',
        file_type: 'application/pdf',
        status: 'rejected',
        notes: 'Da correggere',
        created_at: '2026-04-22T08:00:00.000Z',
        source: 'upload'
      }
    ];
    this.resourceRows = [
      {
        id: 'resource-1',
        title: 'Materiale approvato',
        description: 'Pubblicato',
        file_url: 'https://cdn.example.com/approved.pdf',
        file_name: null,
        file_size: 2048,
        file_type: 'pdf',
        status: 'approved',
        created_at: '2026-04-23T10:00:00.000Z',
        source: 'admin'
      }
    ];
    this.adminRows = [
      {
        id: 'pending-1',
        facultyId: 'fac-1',
        lessonId: 'lesson-1',
        fileUrl: 'https://cdn.example.com/slide-seminario.pdf',
        fileName: 'slide-seminario.pdf',
        fileType: 'application/pdf',
        title: 'Slide seminario',
        description: 'Versione aggiornata',
        status: 'pending',
        notes: null,
        createdAt: '2026-04-24T08:00:00.000Z',
        updatedAt: '2026-04-24T08:00:00.000Z',
        teacherFirstName: 'Mario',
        teacherLastName: 'Rossi',
        teacherEmail: 'mario@example.com',
        lessonTitle: 'Lezione 1',
        lessonStartDateTime: '2026-04-25T08:00:00.000Z'
      }
    ];
  }

  async query(sql, values = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();

    if (normalized.includes('FROM information_schema.columns')) {
      const tableName = values[0];
      if (tableName === 'materials_pending') {
        return {
          rows: [
            { column_name: 'title' },
            { column_name: 'description' },
            { column_name: 'notes' },
            { column_name: 'updated_at' }
          ]
        };
      }

      if (tableName === 'resources') {
        return {
          rows: [
            { column_name: 'description' },
            { column_name: 'file_size_bytes' },
            { column_name: 'resource_type' },
            { column_name: 'is_published' },
            { column_name: 'teacher_id' }
          ]
        };
      }

      return {
        rows: []
      };
    }

    if (normalized.includes("FROM materials_pending WHERE faculty_id = $1 AND status != 'approved'")) {
      return { rows: this.pendingRows.map((row) => ({ ...row })) };
    }

    if (normalized.includes("FROM resources") && normalized.includes("WHERE teacher_id = $1")) {
      return { rows: this.resourceRows.map((row) => ({ ...row })) };
    }

    if (normalized.includes('FROM materials_pending mp') && normalized.includes('LEFT JOIN faculty f')) {
      return { rows: this.adminRows.map((row) => ({ ...row })) };
    }

    throw new Error(`Unsupported query in FakeTeacherMaterialsPool: ${normalized}`);
  }
}

class LegacyTeacherMaterialsPool extends FakeTeacherMaterialsPool {
  async query(sql, values = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();

    if (normalized.includes('FROM information_schema.columns')) {
      const tableName = values[0];
      if (tableName === 'materials_pending') {
        return {
          rows: [
            { column_name: 'notes' },
            { column_name: 'updated_at' }
          ]
        };
      }

      if (tableName === 'resources') {
        return {
          rows: [
            { column_name: 'description' },
            { column_name: 'file_size_bytes' },
            { column_name: 'resource_type' },
            { column_name: 'is_published' }
          ]
        };
      }
    }

    if (normalized.includes("FROM materials_pending WHERE faculty_id = $1 AND status != 'approved'")) {
      return {
        rows: [
          {
            id: 'legacy-pending-1',
            title: null,
            description: null,
            file_url: 'https://cdn.example.com/legacy.pdf',
            file_name: 'legacy.pdf',
            file_type: 'application/pdf',
            status: 'pending',
            notes: null,
            created_at: '2026-04-24T08:00:00.000Z',
            source: 'upload'
          }
        ]
      };
    }

    return super.query(sql, values);
  }
}

test('buildTeacherLessonAccessQuery permette il match per email del docente', () => {
  const query = buildTeacherLessonAccessQuery('fac-1', 'lesson-1');

  assert.match(query.text, /l\.teacher_id = \$1/);
  assert.match(query.text, /f\.email = \(SELECT email FROM faculty WHERE id = \$1\)/);
  assert.deepEqual(query.values, ['fac-1', 'lesson-1']);
});

test('buildMaterialsPendingInsertPayload salva title e description', () => {
  const payload = buildMaterialsPendingInsertPayload({
    teacherFacultyId: 'fac-1',
    lessonId: 'lesson-1',
    url: 'https://cdn.example.com/materiale.pdf',
    fileOriginalName: 'materiale.pdf',
    fileMimeType: 'application/pdf',
    title: 'Materiale docente',
    description: 'Dispensa del seminario'
  });

  assert.match(payload.text, /title, description, status/);
  assert.deepEqual(payload.values, [
    'fac-1',
    'lesson-1',
    'https://cdn.example.com/materiale.pdf',
    'materiale.pdf',
    'application/pdf',
    'Materiale docente',
    'Dispensa del seminario'
  ]);
});

test('getTeacherMaterialResourceTitle usa il title salvato prima del nome file', () => {
  assert.equal(
    getTeacherMaterialResourceTitle({ title: 'Slide corso', fileName: 'slides.pdf' }),
    'Slide corso'
  );
  assert.equal(
    getTeacherMaterialResourceTitle({ title: null, fileName: 'slides.pdf' }),
    'slides.pdf'
  );
});

test('GET /api/teachers/materials mostra pending/rejected da materials_pending e approved da resources senza duplicati', async () => {
  apiModule.__setPool(new FakeTeacherMaterialsPool());
  const handler = findRouteHandler('/api/teachers/materials', 'get');
  const req = { teacher: { id: 'fac-1' } };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 3);
  assert.deepEqual(
    res.body.map((item) => item.status),
    ['pending', 'approved', 'rejected']
  );
  assert.equal(res.body[0].title, 'Slide seminario');
  assert.equal(res.body[1].title, 'Materiale approvato');
});

test('GET /api/admin/teacher-materials restituisce il title del materiale pending', async () => {
  apiModule.__setPool(new FakeTeacherMaterialsPool());
  const handler = findRouteHandler('/api/admin/teacher-materials', 'get');
  const req = { query: {} };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body[0].title, 'Slide seminario');
  assert.equal(res.body[0].fileName, 'slide-seminario.pdf');
});

test('GET /api/teachers/materials tollera schema legacy di resources senza teacher_id', async () => {
  apiModule.__setPool(new LegacyTeacherMaterialsPool());
  const handler = findRouteHandler('/api/teachers/materials', 'get');
  const req = { teacher: { id: 'fac-1' } };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].file_name, 'legacy.pdf');
  assert.equal(res.body[0].title, null);
});
