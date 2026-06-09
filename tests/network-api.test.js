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
        assert.equal(params[7], 'Project work e partnership');
        assert.equal(params[8], 'https://example.com/photo.jpg');
        assert.equal(params[9], 'https://example.com/cover.jpg');
        assert.deepEqual(JSON.parse(params[10]), [{ title: 'CEO', organization: 'POSTI', period: '2024-oggi', description: 'Innovazione' }]);
        assert.deepEqual(JSON.parse(params[11]), [{ label: 'Portfolio', url: 'https://example.com' }]);
        assert.deepEqual(params[12], ['MRV', 'Suolo']);
        assert.deepEqual(params[13], ['Policy', 'ETS']);
        assert.equal(params[14], null, 'URL non http(s) deve essere scartato');
        assert.equal(params[16], true);
        assert.equal(params[17], true);
        assert.equal(params[18], false);
        return {
          rows: [{
            userId: params[0],
            headline: params[1],
            organization: params[2],
            roleTitle: params[3],
            city: params[4],
            country: params[5],
            bio: params[6],
            collaborationGoals: params[7],
            profilePhotoUrl: params[8],
            coverImageUrl: params[9],
            experience: JSON.parse(params[10]),
            featuredLinks: JSON.parse(params[11]),
            skills: params[12],
            interests: params[13],
            linkedinUrl: params[14],
            contactEmail: params[15],
            isVisible: params[16],
            showEmail: params[17],
            showLinkedin: params[18],
            availableForContact: params[19],
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
            role: 'student',
            userAvatarUrl: null
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
      collaborationGoals: 'Project work e partnership',
      profilePhotoUrl: 'https://example.com/photo.jpg',
      coverImageUrl: 'https://example.com/cover.jpg',
      experience: [{ title: 'CEO', organization: 'POSTI', period: '2024-oggi', description: 'Innovazione' }],
      featuredLinks: [{ label: 'Portfolio', url: 'https://example.com' }],
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
            collaborationGoals: 'Cerca partner per progetti pilota.',
            profilePhotoUrl: 'https://example.com/profile.jpg',
            coverImageUrl: 'https://example.com/cover.jpg',
            experience: [{ title: 'Founder', organization: 'Azienda Agricola', period: '2025-oggi' }],
            featuredLinks: [{ label: 'Sito', url: 'https://example.com' }],
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
  assert.equal(res.body[0].profilePhotoUrl, 'https://example.com/profile.jpg');
  assert.equal(res.body[0].experience[0].title, 'Founder');
});
