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

      if (statement.startsWith('SELECT ll.id, ll.lms_module_id AS "moduleId", ll.title, ll.description')) {
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

test('POST /api/lms/lessons rifiuta lezioni senza collegamento calendario', async () => {
  apiModule.__setPool({
    async query() {
      throw new Error('query non attesa');
    }
  });

  const layer = findRoute('/api/lms/lessons', 'post');
  assert.ok(layer, 'route POST /api/lms/lessons non trovata');

  const req = {
    method: 'POST',
    url: '/api/lms/lessons',
    body: {
      moduleId: 'module-1',
      title: 'Lezione senza calendario'
    },
    headers: {}
  };
  const res = createJsonRes();

  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'calendarLessonId is required');
});

test('POST /api/lms/lessons/:id/complete richiede materiali e quiz anche con presenza live', async () => {
  let asyncAttendanceInsertCalled = false;
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();

      if (statement.includes('FROM lms_lessons WHERE id = $1')) {
        assert.deepEqual(params, ['lesson-1']);
        return {
          rows: [{
            id: 'lesson-1',
            moduleId: 'module-1',
            durationSeconds: 3600,
            calendarLessonId: 'calendar-1'
          }]
        };
      }

      if (statement.includes('FROM attendance a') && statement.includes("attendance_type IN ('in_person', 'remote_live')")) {
        assert.deepEqual(params, ['calendar-1', 'user-1']);
        return { rows: [{ id: 'attendance-1' }] };
      }

      if (statement === 'SELECT progress_percent, time_spent_seconds, completed_at FROM lesson_progress WHERE user_id = $1 AND lms_lesson_id = $2') {
        assert.deepEqual(params, ['user-1', 'lesson-1']);
        return {
          rows: [{
            progress_percent: 35,
            time_spent_seconds: 900,
            completed_at: null
          }]
        };
      }

      if (statement.includes('COUNT(DISTINCT r.id)::int AS "materialTotal"')) {
        assert.deepEqual(params, ['calendar-1', 'user-1']);
        return {
          rows: [{
            materialTotal: 2,
            materialViewed: 2,
            viewedResourceIds: ['resource-1', 'resource-2']
          }]
        };
      }

      if (statement.includes('FROM quizzes') && statement.includes('lms_lesson_id = $1 OR lms_module_id = $2')) {
        assert.deepEqual(params, ['lesson-1', 'module-1']);
        return { rows: [{ id: 'quiz-1' }] };
      }

      if (statement.includes('MAX(COALESCE(percentage, score))::int AS "bestScore"')) {
        assert.deepEqual(params, ['user-1', ['quiz-1']]);
        return {
          rows: [{ bestScore: 75 }]
        };
      }

      if (statement.startsWith('UPDATE lesson_progress SET completed_at = NOW()')) {
        assert.deepEqual(params, ['user-1', 'lesson-1']);
        return { rows: [] };
      }

      if (statement.startsWith('INSERT INTO attendance (id, user_id, lms_lesson_id, attendance_type, method)')) {
        asyncAttendanceInsertCalled = true;
        return { rows: [] };
      }

      throw new Error(`Unexpected query in completion test: ${statement}`);
    }
  });

  const layer = findRoute('/api/lms/lessons/:id/complete', 'post');
  assert.ok(layer, 'route POST /api/lms/lessons/:id/complete non trovata');

  const req = {
    method: 'POST',
    url: '/api/lms/lessons/lesson-1/complete',
    params: { id: 'lesson-1' },
    headers: {},
    user: { userId: 'user-1' },
    body: {}
  };
  const res = createJsonRes();

  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.completed, true);
  assert.equal(res.body.criteria.attendance, true);
  assert.equal(res.body.criteria.video, true);
  assert.equal(res.body.criteria.materials, true);
  assert.equal(res.body.criteria.quiz, true);
  assert.equal(asyncAttendanceInsertCalled, false);
});

test('GET /api/lms/lessons/:id usa il fallback per materiali calendar_lesson quando il legame diretto manca', async () => {
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();

      if (statement.includes('FROM lms_lessons ll LEFT JOIN lessons cal ON cal.id = ll.calendar_lesson_id')) {
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
            materials: [],
            calendarLessonId: 'calendar-1',
            calendarLessonTitle: 'Lezione 1',
            createdAt: '2026-04-30T10:00:00.000Z',
            updatedAt: '2026-04-30T10:00:00.000Z'
          }]
        };
      }

      if (statement.includes('WHERE r.lesson_id = $1')) {
        assert.deepEqual(params, ['calendar-1']);
        return { rows: [] };
      }

      if (statement.includes('COALESCE(r.source, \'admin\') = \'calendar_lesson\'') && statement.includes('LOWER(TRIM(r.title)) = LOWER(TRIM($1))')) {
        assert.deepEqual(params, ['Lezione 1', 'Lezione 1']);
        return {
          rows: [{
            id: 'resource-fallback',
            title: 'Lezione 1',
            url: 'https://example.com/fallback.pdf',
            resourceType: 'pdf',
            description: null,
            teacherName: 'Prof. Test',
            isPublished: true,
            reviewStatus: 'teacher_approved'
          }]
        };
      }

      throw new Error(`Unsupported query in test fallback: ${statement}`);
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
  assert.deepEqual(res.body.linkedResources, [
    {
      id: 'resource-fallback',
      title: 'Lezione 1',
      url: 'https://example.com/fallback.pdf',
      resourceType: 'pdf',
      description: null,
      teacherName: 'Prof. Test',
      isPublished: true,
      reviewStatus: 'teacher_approved'
    }
  ]);
});

test('GET /api/lms/quizzes/:id/attempts espone come score la percentuale salvata', async () => {
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      assert.match(statement, /COALESCE\(percentage, score\)::int AS score/);
      assert.match(statement, /completed_at IS NOT NULL/);
      assert.deepEqual(params, ['user-1', 'quiz-1']);
      return {
        rows: [{
          id: 'attempt-1',
          score: 86,
          percentage: 86,
          passed: true,
          startedAt: '2026-05-06T08:00:00.000Z',
          completedAt: '2026-05-06T08:05:00.000Z'
        }]
      };
    }
  });

  const layer = findGetRoute('/api/lms/quizzes/:id/attempts');
  assert.ok(layer, 'route /api/lms/quizzes/:id/attempts non trovata');

  const req = {
    method: 'GET',
    url: '/api/lms/quizzes/quiz-1/attempts',
    params: { id: 'quiz-1' },
    headers: {},
    user: { userId: 'user-1' }
  };
  const res = createJsonRes();

  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, [{
    id: 'attempt-1',
    score: 86,
    percentage: 86,
    passed: true,
    startedAt: '2026-05-06T08:00:00.000Z',
    completedAt: '2026-05-06T08:05:00.000Z'
  }]);
});

test('GET /api/admin/student-progress aggrega frequenza, quiz, materiali e domande', async () => {
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();

      if (statement.includes('FROM course_editions ce') && statement.includes('JOIN courses c ON c.id = ce.course_id')) {
        assert.deepEqual(params, ['edition-1']);
        return {
          rows: [{
            id: 'edition-1',
            editionName: '2026',
            courseId: 'course-1',
            courseTitle: 'Master Carbon Farming'
          }]
        };
      }

      if (statement.includes('FROM enrollments e') && statement.includes('JOIN users u ON u.id = e.user_id')) {
        assert.deepEqual(params, ['edition-1']);
        return {
          rows: [
            {
              userId: 'student-1',
              firstName: 'Anna',
              lastName: 'Rossi',
              email: 'anna@example.com'
            },
            {
              userId: 'student-2',
              firstName: 'Luca',
              lastName: 'Bianchi',
              email: 'luca@example.com'
            }
          ]
        };
      }

      if (statement === 'SELECT id FROM modules WHERE course_id = $1') {
        assert.deepEqual(params, ['course-1']);
        return { rows: [{ id: 'module-1' }] };
      }

      if (statement.includes('FROM lms_lessons ll') && statement.includes('JOIN modules m ON m.id = ll.lms_module_id')) {
        assert.deepEqual(params, ['course-1']);
        return { rows: [{ id: 'lesson-1', calendarLessonId: 'calendar-1' }] };
      }

      if (statement.includes('FROM attendance a') && statement.includes('a.lesson_id = ANY($2::uuid[]) OR a.lms_lesson_id = ANY($3::uuid[])')) {
        assert.deepEqual(params, [['student-1', 'student-2'], ['calendar-1'], ['lesson-1']]);
        return {
          rows: [{
            userId: 'student-1',
            inPerson: 1,
            remoteLive: 0,
            remotePartial: 0,
            async: 0,
            total: 1,
            lastAttendanceAt: '2026-05-06T08:00:00.000Z'
          }]
        };
      }

      if (statement.includes('FROM lesson_progress lp')) {
        assert.deepEqual(params, [['student-1', 'student-2'], ['lesson-1']]);
        return {
          rows: [{
            userId: 'student-1',
            completedLessons: 1,
            progressedLessons: 1,
            avgProgress: '100.00',
            lastProgressAt: '2026-05-06T09:00:00.000Z'
          }]
        };
      }

      if (statement.includes('FROM resources r') && statement.includes('r.resource_type <> \'quiz\'') && statement.includes('COUNT(DISTINCT r.id)::int AS total')) {
        assert.deepEqual(params, [['calendar-1']]);
        return { rows: [{ total: 4 }] };
      }

      if (statement.includes('FROM resource_views rv') && statement.includes('JOIN resources r ON r.id = rv.resource_id')) {
        assert.deepEqual(params, [['student-1', 'student-2'], ['calendar-1']]);
        return {
          rows: [{
            userId: 'student-1',
            viewedResources: 3,
            resourceViews: 5,
            lastResourceAt: '2026-05-06T10:00:00.000Z'
          }]
        };
      }

      if (statement.includes('FROM quizzes') && statement.includes('lms_lesson_id = ANY($1::uuid[]) OR lms_module_id = ANY($2::uuid[])')) {
        assert.deepEqual(params, [['lesson-1'], ['module-1']]);
        return {
          rows: [
            { id: 'quiz-1' },
            { id: 'quiz-2' }
          ]
        };
      }

      if (statement.includes('FROM quiz_attempts qa') && statement.includes('qa.completed_at IS NOT NULL')) {
        assert.deepEqual(params, [['student-1', 'student-2'], ['quiz-1', 'quiz-2']]);
        return {
          rows: [
            {
              userId: 'student-1',
              attempts: 1,
              passedAttempts: 1,
              bestScore: 90,
              avgScore: '90.00',
              lastQuizAt: '2026-05-06T11:00:00.000Z'
            },
            {
              userId: 'student-2',
              attempts: 1,
              passedAttempts: 0,
              bestScore: 60,
              avgScore: '60.00',
              lastQuizAt: '2026-05-05T11:00:00.000Z'
            }
          ]
        };
      }

      if (statement.includes('FROM student_questions sq') && statement.includes('LEFT JOIN question_replies qr ON qr.question_id = sq.id')) {
        assert.deepEqual(params, [['student-1', 'student-2'], ['lesson-1'], ['module-1']]);
        return {
          rows: [{
            userId: 'student-1',
            questionsAsked: 2,
            repliesReceived: 1,
            lastQuestionAt: '2026-05-06T12:00:00.000Z'
          }]
        };
      }

      throw new Error(`Unsupported query in student progress test: ${statement}`);
    }
  });

  const layer = findGetRoute('/api/admin/student-progress');
  assert.ok(layer, 'route /api/admin/student-progress non trovata');

  const req = {
    method: 'GET',
    url: '/api/admin/student-progress?courseEditionId=edition-1',
    query: { courseEditionId: 'edition-1' },
    headers: {},
    user: { role: 'admin' }
  };
  const res = createJsonRes();

  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.edition.id, 'edition-1');
  assert.equal(res.body.summary.studentsCount, 2);
  assert.equal(res.body.summary.totalLessons, 1);
  assert.equal(res.body.summary.totalResources, 4);
  assert.equal(res.body.summary.quizPassRate, 50);
  assert.equal(res.body.students[0].userId, 'student-1');
  assert.equal(res.body.students[0].overallPercent, 91);
  assert.equal(res.body.students[1].overallPercent, 15);
  assert.deepEqual(res.body.attendanceBreakdown, [
    { key: 'inPerson', label: '🏫 In sito', count: 1 },
    { key: 'remoteLive', label: '💻 Online', count: 0 },
    { key: 'remotePartial', label: '⏱️ Online parziale', count: 0 },
    { key: 'async', label: '📹 Offline / asincrona', count: 0 }
  ]);
});

test('POST /api/teachers/student-view-token genera un token guest per la consultazione studenti', async () => {
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      assert.match(statement, /SELECT id, email, first_name, last_name FROM faculty WHERE id = \$1 LIMIT 1/);
      assert.deepEqual(params, ['teacher-1']);
      return {
        rows: [{
          id: 'teacher-1',
          email: 'docente@example.com',
          first_name: 'Giulia',
          last_name: 'Verdi'
        }]
      };
    }
  });

  const layer = apiModule.app._router.stack.find((entry) => entry?.route?.path === '/api/teachers/student-view-token' && entry.route.methods.post);
  assert.ok(layer, 'route POST /api/teachers/student-view-token non trovata');

  const req = {
    method: 'POST',
    url: '/api/teachers/student-view-token',
    headers: {},
    teacher: { id: 'teacher-1' }
  };
  const res = createJsonRes();

  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.user.role, 'guest');
  assert.equal(res.body.user.teacherId, 'teacher-1');
  assert.equal(res.body.user.firstName, 'Giulia');
  assert.equal(res.body.user.accessMode, 'student_view');
});

test('GET /api/students/me ritorna un profilo sintetico per la vista guest', async () => {
  let queryCalled = false;
  apiModule.__setPool({
    async query() {
      queryCalled = true;
      throw new Error('query non attesa');
    }
  });

  const layer = apiModule.app._router.stack.find((entry) => entry?.route?.path === '/api/students/me' && entry.route.methods.get);
  assert.ok(layer, 'route GET /api/students/me non trovata');

  const req = {
    method: 'GET',
    url: '/api/students/me',
    headers: {},
    user: {
      role: 'guest',
      teacherId: 'teacher-1',
      email: 'docente@example.com',
      firstName: 'Giulia',
      lastName: 'Verdi'
    }
  };
  const res = createJsonRes();

  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(queryCalled, false);
  assert.equal(res.body.role, 'guest');
  assert.equal(res.body.firstName, 'Giulia');
  assert.equal(res.body.accessMode, 'student_view');
});

test('GET /api/lms/my-courses ritorna i corsi per la vista guest docente', async () => {
  let queryCount = 0;
  apiModule.__setPool({
    async query(sql, params = []) {
      queryCount += 1;
      const statement = String(sql).replace(/\s+/g, ' ').trim();

      if (statement.includes('FROM lessons l') && statement.includes('JOIN modules m ON m.id = l.module_id') && statement.includes('JOIN courses c ON c.id = m.course_id') && statement.includes('WHERE l.teacher_id = $1')) {
        assert.deepEqual(params, ['teacher-1']);
        return { rows: [] };
      }

      if (statement.includes('FROM course_editions ce') && statement.includes('JOIN courses c ON c.id = ce.course_id') && statement.includes('WHERE ce.is_active = true')) {
        return {
          rows: [{
            id: 'course-1',
            title: 'Master Carbon Farming',
            slug: 'master-carbon-farming',
            description: 'Corso',
            coverImageUrl: null,
            editionId: 'edition-1',
            editionName: 'Edizione 2026',
            totalPlannedHours: 432,
            minimumInPersonAttendanceRatio: 0.7,
            enrollmentStatus: null,
            enrolledAt: null,
            totalModules: 3,
            totalLessons: 12,
            attendedHours: 0,
            inPersonHours: 0,
            completedLessons: 0
          }]
        };
      }

      if (statement.includes('FROM information_schema')) {
        return { rows: [] };
      }

      throw new Error(`Unsupported query in guest courses test: ${statement}`);
    }
  });

  const layer = findGetRoute('/api/lms/my-courses');
  assert.ok(layer, 'route GET /api/lms/my-courses non trovata');

  const req = {
    method: 'GET',
    url: '/api/lms/my-courses',
    headers: {},
    user: {
      role: 'guest',
      teacherId: 'teacher-1'
    }
  };
  const res = createJsonRes();

  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, 'course-1');
  assert.equal(res.body[0].totalLessons, 12);
  assert.equal(queryCount, 3);
});

test('POST /api/quiz-attempts/:id/submit valuta correttamente i quiz LMS anche con risposte serializzate', async () => {
  const queries = [];
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ statement, params });

      if (statement === 'SELECT * FROM quiz_attempts WHERE id = $1 AND user_id = $2') {
        assert.deepEqual(params, ['attempt-1', 'user-1']);
        return {
          rows: [{
            id: 'attempt-1',
            user_id: 'user-1',
            quiz_id: 'quiz-1',
            resource_id: null,
            started_at: '2026-05-06T08:00:00.000Z',
            completed_at: null
          }]
        };
      }

      if (statement === 'SELECT passing_score FROM quizzes WHERE id = $1') {
        assert.deepEqual(params, ['quiz-1']);
        return { rows: [{ passing_score: 70 }] };
      }

      if (statement.includes('FROM quiz_questions WHERE quiz_id = $1 ORDER BY sort_order')) {
        assert.deepEqual(params, ['quiz-1']);
        return {
          rows: [
            {
              question_text: 'Q1',
              options: ['A', 'B'],
              correct_answer: '"A"',
              points: 1
            },
            {
              question_text: 'Q2',
              options: ['C', 'D'],
              correct_answer: '"D"',
              points: 1
            }
          ]
        };
      }

      if (statement.startsWith('UPDATE quiz_attempts SET')) {
        assert.match(statement, /percentage = \$4/);
        assert.deepEqual(params[1], 2);
        assert.deepEqual(params[2], 2);
        assert.deepEqual(params[3], 100);
        assert.deepEqual(params[4], true);
        return { rows: [{ id: 'attempt-1' }] };
      }

      throw new Error(`Unsupported query in quiz submit test: ${statement}`);
    }
  });

  const layer = apiModule.app._router.stack.find((entry) => entry?.route?.path === '/api/quiz-attempts/:id/submit' && entry.route.methods.post);
  assert.ok(layer, 'route POST /api/quiz-attempts/:id/submit non trovata');

  const req = {
    method: 'POST',
    url: '/api/quiz-attempts/attempt-1/submit',
    params: { id: 'attempt-1' },
    body: {
      answers: [
        { questionIndex: 0, selectedAnswer: 'A' },
        { questionIndex: 1, selectedAnswer: 'D' }
      ]
    },
    headers: {},
    user: { userId: 'user-1' }
  };
  const res = createJsonRes();

  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.percentage, 100);
  assert.equal(res.body.passed, true);
  assert.equal(res.body.answers[0].isCorrect, true);
  assert.equal(res.body.answers[1].isCorrect, true);
  assert.ok(queries.length >= 4);
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
