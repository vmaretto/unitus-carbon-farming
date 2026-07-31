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

test('POST /api/projects consente anche a uno studente di proporre un progetto', async (t) => {
  const studentId = '55555555-5555-4555-8555-555555555555';
  let insertParams = null;
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      assert.match(statement, /^INSERT INTO network_opportunities/);
      insertParams = params;
      return {
        rows: [{
          id: 'student-project-1', title: params[0], type: params[1], organization: params[2],
          organizationType: params[3], sector: params[4], location: params[5], description: params[6],
          skills: params[7], interests: params[8], duration: params[9], commitment: params[10],
          workMode: params[11], contactEmail: params[12], deadline: params[13],
          supervisorId: params[15], acceptsApplications: params[16], isPublished: false
        }]
      };
    }
  });
  t.after(() => apiModule.__setPool(null));

  const layer = findRoute('/api/projects', 'post');
  const req = {
    headers: tokenHeaders({ userId: studentId, email: 'student@example.com', role: 'student' }),
    body: {
      title: 'Project work studente', organization: 'Azienda Agricola',
      description: 'Proposta presentata da uno studente.', skills: ['GIS']
    }
  };
  const res = createJsonRes();
  await runRoute(layer, req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(insertParams[14], null, 'uno studente non viene registrato come docente creatore');
  assert.equal(insertParams[17], studentId, 'la proposta viene associata all\'utente');
  assert.equal(res.body.canManage, true);
});

test('POST /api/projects consente a un referente guest di proporre un progetto', async (t) => {
  const guestId = '66666666-6666-4666-8666-666666666666';
  let insertParams = null;
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      assert.match(statement, /^INSERT INTO network_opportunities/);
      insertParams = params;
      return {
        rows: [{
          id: 'guest-project-1', title: params[0], type: params[1], organization: params[2],
          organizationType: params[3], sector: params[4], location: params[5], description: params[6],
          skills: params[7], interests: params[8], duration: params[9], commitment: params[10],
          workMode: params[11], contactEmail: params[12], deadline: params[13],
          supervisorId: params[15], acceptsApplications: params[16], isPublished: false
        }]
      };
    }
  });
  t.after(() => apiModule.__setPool(null));

  const layer = findRoute('/api/projects', 'post');
  const req = {
    headers: tokenHeaders({ userId: guestId, email: 'partner@example.com', role: 'guest' }),
    body: {
      title: 'Sfida del partner', organization: 'Partner Carbon Farm',
      description: 'Proposta presentata da un referente partner.', organizationType: 'partner'
    }
  };
  const res = createJsonRes();
  await runRoute(layer, req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(insertParams[14], null);
  assert.equal(insertParams[17], guestId);
  assert.equal(res.body.canManage, true);
});

test('POST admin opportunità salva tutti i campi del progetto', async (t) => {
  const supervisorId = '33333333-3333-4333-8333-333333333333';
  let insertParams = null;
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      if (statement.startsWith('INSERT INTO network_opportunities')) {
        insertParams = params;
        return {
          rows: [{
            id: 'admin-project-1',
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
            applyUrl: params[12],
            contactEmail: params[13],
            deadline: params[14],
            supervisorId: params[15],
            acceptsApplications: params[16],
            isPublished: params[17]
          }]
        };
      }
      if (statement.includes('FROM faculty WHERE id = $1')) {
        assert.deepEqual(params, [supervisorId]);
        return { rows: [{ name: 'Prof. Mario Rossi' }] };
      }
      throw new Error(`Query inattesa: ${statement}`);
    }
  });
  t.after(() => apiModule.__setPool(null));

  const layer = findRoute('/api/admin/network/opportunities', 'post');
  assert.ok(layer, 'route POST admin opportunità non trovata');
  const req = {
    headers: tokenHeaders({ role: 'admin' }),
    body: {
      title: 'MRV per aziende agricole',
      type: 'lavoro',
      organization: 'Carbon Farm Lab',
      organizationType: 'partner',
      sector: 'Agricoltura',
      location: 'Viterbo',
      description: 'Applicazione operativa di un protocollo MRV.',
      skills: 'MRV, GIS, mrv',
      interests: ['Suolo', 'Carbon accounting'],
      duration: '4 mesi',
      commitment: '8 ore/settimana',
      workMode: 'hybrid',
      supervisorTeacherId: supervisorId,
      acceptsApplications: true,
      isPublished: true
    }
  };
  const res = createJsonRes();
  await runRoute(layer, req, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(insertParams[7], ['MRV', 'GIS']);
  assert.deepEqual(insertParams[8], ['Suolo', 'Carbon accounting']);
  assert.equal(insertParams[15], supervisorId);
  assert.equal(res.body.supervisor.name, 'Prof. Mario Rossi');
  assert.equal(res.body.isPublished, true);
});

test('PATCH candidatura progetto consente all admin di aggiornarne lo stato', async (t) => {
  const applicationId = '44444444-4444-4444-8444-444444444444';
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      assert.match(statement, /^UPDATE network_opportunity_applications/);
      assert.deepEqual(params, [applicationId, 'accepted']);
      return { rows: [{ id: applicationId, status: 'accepted', updatedAt: '2026-07-31T10:00:00.000Z' }] };
    }
  });
  t.after(() => apiModule.__setPool(null));

  const layer = findRoute('/api/projects/applications/:id', 'patch');
  assert.ok(layer, 'route PATCH candidatura progetto non trovata');
  const req = {
    headers: tokenHeaders({ role: 'admin' }),
    params: { id: applicationId },
    body: { status: 'accepted' }
  };
  const res = createJsonRes();
  await runRoute(layer, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'accepted');
});

test('la pagina Progetti è integrata nelle aree studenti e docenti', () => {
  const projectPage = fs.readFileSync(path.join(__dirname, '..', 'learn', 'projects.html'), 'utf8');
  const studentDashboard = fs.readFileSync(path.join(__dirname, '..', 'learn', 'index.html'), 'utf8');
  const teacherDashboard = fs.readFileSync(path.join(__dirname, '..', 'teachers', 'index.html'), 'utf8');
  const adminDashboard = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');

  assert.match(projectPage, /localStorage\.getItem\('learnToken'\)/);
  assert.match(projectPage, /localStorage\.getItem\('teacherToken'\)/);
  assert.match(projectPage, /\/api\/projects/);
  assert.match(studentDashboard, /href="\/learn\/projects\.html">Progetti/);
  assert.match(teacherDashboard, /href="\/learn\/projects\.html\?role=teacher"/);
  assert.match(adminDashboard, /data-section="projects"/);
  assert.match(adminDashboard, /<section id="projects">/);
  assert.match(adminDashboard, /id="opportunity-supervisor"/);
  assert.match(adminDashboard, /\/api\/projects\/applications\/\$\{select\.dataset\.opApplicationStatus\}/);
  assert.match(projectPage, /\['student', 'teacher', 'guest'\]\.includes\(actor\.role\)/);
  assert.match(projectPage, /Referente ospite/);
});
