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

test('GET /api/attendance/report/:courseEditionId espone i minuti nella vista singola lezione', async (t) => {
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();

      if (statement.includes('FROM enrollments e') && statement.includes('JOIN users u ON u.id = e.user_id')) {
        assert.deepEqual(params, ['edition-1']);
        return {
          rows: [{
            id: 'student-1',
            email: 'studente@example.com',
            firstName: 'Mario',
            lastName: 'Rossi'
          }]
        };
      }

      if (statement.includes('SELECT DISTINCT l.id, l.title, l.start_datetime AS "startDatetime"')) {
        return { rows: [{ id: 'lesson-1', title: 'Lezione SOC', startDatetime: '2026-05-21T12:00:00.000Z' }] };
      }

      if (statement.includes('SELECT ll.id, ll.title') && statement.includes('FROM lms_lessons ll')) {
        return { rows: [] };
      }

      if (statement.includes('SELECT COALESCE(total_planned_hours, 432) AS total_planned_hours')) {
        return { rows: [{ total_planned_hours: 432 }] };
      }

      if (statement.includes('FROM attendance a') && statement.includes('COALESCE(les.duration_minutes, 0) AS duration_minutes')) {
        assert.deepEqual(params, [['student-1'], 'lesson-1']);
        return {
          rows: [{
            id: 'attendance-1',
            user_id: 'student-1',
            lesson_id: 'lesson-1',
            lms_lesson_id: null,
            attendance_type: 'remote_partial',
            method: 'csv_import',
            notes: 'zoom_duration_minutes=47',
            check_in_at: '2026-05-21T11:55:00.000Z',
            check_out_at: '2026-05-21T12:42:00.000Z',
            duration_minutes: 120
          }]
        };
      }

      throw new Error(`Unsupported query in attendance report test: ${statement}`);
    }
  });
  t.after(() => {
    apiModule.__setPool(null);
  });

  const layer = findRoute('/api/attendance/report/:courseEditionId', 'get');
  assert.ok(layer, 'route GET /api/attendance/report/:courseEditionId non trovata');

  const req = {
    method: 'GET',
    url: '/api/attendance/report/edition-1?lessonId=lesson-1',
    params: { courseEditionId: 'edition-1' },
    query: { lessonId: 'lesson-1' },
    headers: {}
  };
  const res = createRes();

  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.students[0].attendanceMinutes, 47);
  assert.equal(res.body.students[0].attendances[0].attendanceMinutes, 47);
});
