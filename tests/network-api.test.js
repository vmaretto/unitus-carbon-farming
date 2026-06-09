const test = require('node:test');
const assert = require('node:assert/strict');

const apiModule = require('../api/index.js');

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

async function runRoute(layer, req, res) {
  const stack = layer.route.stack;
  let index = 0;

  async function next(error) {
    if (error) throw error;
    const item = stack[index++];
    if (!item) return;
    await item.handle(req, res, next);
  }

  await next();
}

function authHeaders() {
  const token = apiModule.__generateToken({
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'student@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    role: 'student'
  });
  return { authorization: `Bearer ${token}` };
}

test('PUT /api/lms/network/profile salva il profilo normalizzato', async (t) => {
  const queries = [];
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ statement, params });

      if (statement.startsWith('INSERT INTO network_profiles')) {
        assert.deepEqual(params[7], ['MRV', 'Suolo']);
        assert.deepEqual(params[8], ['Policy', 'ETS']);
        assert.equal(params[9], null, 'URL non http(s) deve essere scartato');
        assert.equal(params[11], true);
        assert.equal(params[12], true);
        assert.equal(params[13], false);
        return {
          rows: [{
            userId: params[0],
            headline: params[1],
            organization: params[2],
            roleTitle: params[3],
            city: params[4],
            country: params[5],
            bio: params[6],
            skills: params[7],
            interests: params[8],
            linkedinUrl: params[9],
            contactEmail: params[10],
            isVisible: params[11],
            showEmail: params[12],
            showLinkedin: params[13],
            availableForContact: params[14],
            updatedAt: '2026-06-09T12:00:00.000Z'
          }]
        };
      }

      if (statement.startsWith('SELECT email AS "userEmail"')) {
        return {
          rows: [{
            userEmail: 'student@example.com',
            firstName: 'Ada',
            lastName: 'Lovelace',
            role: 'student'
          }]
        };
      }

      throw new Error(`query inattesa: ${statement}`);
    }
  });
  t.after(() => apiModule.__setPool(null));

  const layer = findRoute('/api/lms/network/profile', 'put');
  assert.ok(layer, 'route PUT /api/lms/network/profile non trovata');

  const req = {
    method: 'PUT',
    url: '/api/lms/network/profile',
    headers: authHeaders(),
    body: {
      headline: 'Carbon project developer',
      organization: 'Unitus',
      roleTitle: 'Studentessa',
      city: 'Viterbo',
      country: 'Italia',
      bio: 'Bio',
      skills: ['MRV', 'Suolo', 'mrv'],
      interests: 'Policy, ETS',
      linkedinUrl: 'linkedin.com/in/ada',
      contactEmail: 'ada@example.com',
      isVisible: true,
      showEmail: true,
      showLinkedin: false,
      availableForContact: true
    }
  };
  const res = createJsonRes();

  await runRoute(layer, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.fullName, 'Ada Lovelace');
  assert.equal(res.body.contactEmail, 'ada@example.com');
  assert.equal(queries.length, 2);
});

test('GET /api/lms/network/profiles espone solo contatti consentiti', async (t) => {
  apiModule.__setPool({
    async query(sql, params = []) {
      assert.deepEqual(params, []);
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      assert.match(statement, /WHERE p\.is_visible = true/);
      assert.match(statement, /u\.is_active = true/);
      return {
        rows: [
          {
            userId: 'user-1',
            userEmail: 'one@example.com',
            firstName: 'Uno',
            lastName: 'Studente',
            role: 'student',
            headline: 'Agronomo',
            organization: 'Azienda Agricola',
            roleTitle: 'Founder',
            city: 'Roma',
            country: 'Italia',
            bio: 'Lavora su suolo e MRV.',
            skills: ['MRV'],
            interests: ['Suolo'],
            linkedinUrl: 'https://linkedin.com/in/uno',
            contactEmail: 'contact@example.com',
            isVisible: true,
            showEmail: false,
            showLinkedin: true,
            availableForContact: true,
            updatedAt: '2026-06-09T12:00:00.000Z'
          }
        ]
      };
    }
  });
  t.after(() => apiModule.__setPool(null));

  const layer = findRoute('/api/lms/network/profiles', 'get');
  assert.ok(layer, 'route GET /api/lms/network/profiles non trovata');

  const req = {
    method: 'GET',
    url: '/api/lms/network/profiles',
    headers: authHeaders(),
    query: {}
  };
  const res = createJsonRes();

  await runRoute(layer, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].contactEmail, null);
  assert.equal(res.body[0].linkedinUrl, 'https://linkedin.com/in/uno');
});
