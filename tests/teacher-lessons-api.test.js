const test = require('node:test');
const assert = require('node:assert/strict');

const apiModule = require('../api/index.js');

function findRoute(path, method = 'get') {
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

test('GET /api/teachers/lessons include lezioni passate non cancellate', async (t) => {
  let capturedStatement = '';
  let capturedParams = [];
  apiModule.__setPool({
    async query(sql, params = []) {
      capturedStatement = String(sql).replace(/\s+/g, ' ').trim();
      capturedParams = params;
      return {
        rows: [{
          id: 'lesson-past',
          title: 'Il carbonio organico del suolo (SOC): pools e dinamiche.',
          start_datetime: '2026-05-21T12:00:00.000Z',
          duration_minutes: 120,
          location_physical: null,
          location_remote: 'Zoom',
          status: 'scheduled',
          notes: null,
          module_name: 'Modulo 1',
          lesson_state: 'planned',
          attendance_count: 0,
          materials_uploaded_count: 0
        }]
      };
    }
  });
  t.after(() => {
    apiModule.__setPool(null);
  });

  const layer = findRoute('/api/teachers/lessons', 'get');
  assert.ok(layer, 'route GET /api/teachers/lessons non trovata');

  const req = {
    method: 'GET',
    url: '/api/teachers/lessons',
    query: {},
    headers: {},
    teacher: { id: 'teacher-1' }
  };
  const res = createRes();

  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, 'lesson-past');
  assert.deepEqual(capturedParams, ['teacher-1']);
  assert.match(capturedStatement, /l\.teacher_id = \$1/);
  assert.match(capturedStatement, /COALESCE\(l\.status, 'scheduled'\) != 'cancelled'/);
  assert.doesNotMatch(capturedStatement, /start_datetime >= NOW\(\)/);
});
