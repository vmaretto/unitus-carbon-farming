const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const apiModule = require('../api/index.js');

function findRoute(routePath, method) {
  return apiModule.app._router.stack.find((entry) => {
    return entry?.route?.path === routePath && entry.route.methods[method];
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

async function runRoute(layer, req, res) {
  const stack = layer.route.stack;
  await new Promise((resolve, reject) => {
    const dispatch = (index, error) => {
      if (error) return reject(error);
      const item = stack[index];
      if (!item) return resolve();
      try {
        const result = item.handle(req, res, (nextError) => dispatch(index + 1, nextError));
        Promise.resolve(result)
          .then(() => {
            if (index === stack.length - 1) resolve();
          })
          .catch(reject);
      } catch (routeError) {
        reject(routeError);
      }
    };
    dispatch(0);
  });
}

function tokenHeaders(payload) {
  return {
    authorization: `Bearer ${apiModule.__generateToken(payload)}`
  };
}

test('GET /api/projects calcola il matching dal profilo dello studente', async (t) => {
  const studentId = '11111111-1111-4111-8111-111111111111';
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      if (statement.startsWith('SELECT skills, interests FROM network_profiles')) {
        assert.deepEqual(params, [studentId]);
        return { rows: [{ skills: ['MRV'], interests: ['suolo'] }] };
      }
      if (statement.includes('FROM network_opportunities o')) {
        assert.equal(params[0], studentId);
        assert.equal(params[1], null);
        assert.equal(params[2], false);
        return {
          rows: [{
            id: 'project-1',
            title: 'Monitoraggio carbonio nei suoli',
            type: 'tesi',
            organization: 'Azienda Agricola Unitus',
            organizationType: 'partner',
            sector: 'Agricoltura',
            location: 'Viterbo',
            description: 'Definizione del protocollo di monitoraggio.',
            skills: ['MRV', 'GIS'],
            interests: ['Suolo'],
            duration: '4 mesi',
            commitment: '8 ore/settimana',
            workMode: 'hybrid',
            acceptsApplications: true,
            isPublished: true,
            hasApplied: false,
            applicationsCount: 0,
            canManage: false
          }]
        };
      }
      throw new Error(`Query inattesa: ${statement}`);
    }
  });
  t.after(() => apiModule.__setPool(null));

  const layer = findRoute('/api/projects', 'get');
  assert.ok(layer, 'route GET /api/projects non trovata');
  const req = {
    headers: tokenHeaders({
      userId: studentId,
      email: 'student@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'student'
    })
  };
  const res = createJsonRes();
  await runRoute(layer, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.actor.role, 'student');
  assert.equal(res.body.profile.isComplete, true);
  assert.equal(res.body.projects[0].matchScore, 80);
  assert.deepEqual(res.body.projects[0].matchedSkills, ['MRV']);
});

test('POST /api/projects consente al docente di creare una proposta in bozza', async (t) => {
  const teacherId = '22222222-2222-4222-8222-222222222222';
  let insertParams = null;
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      assert.match(statement, /^INSERT INTO network_opportunities/);
      insertParams = params;
      return {
        rows: [{
          id: 'project-teacher-1',
          title: params[0],
          type: params[1],
          organization: params[2],
          organizationType: params[3],
          sector: params[4],
          location: params[5],
          description: params[6],
          skills: params[7],
          interests: params[8],
          duration: params[9],
          commitment: params[10],
          workMode: params[11],
          contactEmail: params[12],
          deadline: params[13],
          supervisorId: params[14],
          acceptsApplications: params[15],
          isPublished: false,
          applicationsCount: 0
        }]
      };
    }
  });
  t.after(() => apiModule.__setPool(null));

  const layer = findRoute('/api/projects', 'post');
  assert.ok(layer, 'route POST /api/projects non trovata');
  const req = {
    headers: tokenHeaders({
      id: teacherId,
      email: 'teacher@example.com',
      name: 'Mario Rossi',
      role: 'teacher'
    }),
    body: {
      title: 'Bilancio del carbonio di filiera',
      type: 'lavoro',
      organization: 'Terre Unitus',
      organizationType: 'partner',
      sector: 'Cereali',
      location: 'Lazio',
      description: 'Una sfida concreta per gli studenti.',
      skills: ['LCA', 'Analisi dati', 'lca'],
      interests: 'Carbon accounting, filiere',
      duration: '5 mesi',
      commitment: '6 ore/settimana',
      workMode: 'hybrid',
      contactEmail: 'teacher@example.com',
      acceptsApplications: true
    }
  };
  const res = createJsonRes();
  await runRoute(layer, req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(insertParams[14], teacherId);
  assert.deepEqual(insertParams[7], ['LCA', 'Analisi dati']);
  assert.equal(res.body.isPublished, false);
  assert.equal(res.body.canManage, true);
});

test('la pagina Progetti è integrata nelle aree studenti e docenti', () => {
  const projectPage = fs.readFileSync(path.join(__dirname, '..', 'learn', 'projects.html'), 'utf8');
  const studentDashboard = fs.readFileSync(path.join(__dirname, '..', 'learn', 'index.html'), 'utf8');
  const teacherDashboard = fs.readFileSync(path.join(__dirname, '..', 'teachers', 'index.html'), 'utf8');

  assert.match(projectPage, /localStorage\.getItem\('learnToken'\)/);
  assert.match(projectPage, /localStorage\.getItem\('teacherToken'\)/);
  assert.match(projectPage, /\/api\/projects/);
  assert.match(studentDashboard, /href="\/learn\/projects\.html">Progetti/);
  assert.match(teacherDashboard, /href="\/learn\/projects\.html\?role=teacher"/);
});
