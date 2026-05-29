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

class FakeLmsModulePool {
  constructor() {
    this.modules = [{
      id: 'module-1',
      course_id: 'course-1',
      name: 'Seminari',
      description: 'Descrizione precedente',
      sort_order: 0,
      is_published: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }];
  }

  async query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('UPDATE modules SET')) {
      const whereMatch = normalized.match(/WHERE id = \$(\d+)/i);
      const id = whereMatch ? params[Number(whereMatch[1]) - 1] : params[params.length - 1];
      const row = this.modules.find((mod) => mod.id === id);
      if (!row) return { rows: [] };

      const setPart = normalized.split(' WHERE ')[0].replace('UPDATE modules SET ', '');
      const assignments = setPart.split(',').map((item) => item.trim()).filter((item) => item !== 'updated_at = NOW()');
      assignments.forEach((assignment) => {
        const match = assignment.match(/^([a-z_]+) = \$(\d+)$/i);
        if (!match) return;
        row[match[1]] = params[Number(match[2]) - 1];
      });
      row.updated_at = new Date().toISOString();
      return { rows: [{ ...row }] };
    }

    throw new Error(`Unsupported query in FakeLmsModulePool: ${normalized}`);
  }
}

test('PUT /api/lms/modules/:id aggiorna un modulo LMS', async (t) => {
  const pool = new FakeLmsModulePool();
  apiModule.__setPool(pool);
  t.after(() => {
    apiModule.__setPool(null);
  });

  const layer = findRoute('/api/lms/modules/:id', 'put');
  assert.ok(layer, 'route /api/lms/modules/:id non trovata');

  const req = {
    method: 'PUT',
    url: '/api/lms/modules/module-1',
    params: { id: 'module-1' },
    body: {
      courseId: 'course-1',
      title: 'Seminari aggiornati',
      description: 'Seminari su tematiche collegate al carbon farming',
      sortOrder: 0,
      isPublished: true
    },
    headers: {}
  };
  const res = createRes();

  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.title, 'Seminari aggiornati');
  assert.equal(res.body.description, 'Seminari su tematiche collegate al carbon farming');
  assert.equal(pool.modules[0].name, 'Seminari aggiornati');
});
