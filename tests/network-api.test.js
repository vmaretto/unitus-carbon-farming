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
  await new Promise((resolve, reject) => {
    const dispatch = (index, error) => {
      if (error) {
        reject(error);
        return;
      }
      const item = stack[index];
      if (!item) {
        resolve();
        return;
      }
      try {
        const maybe = item.handle(req, res, (nextError) => dispatch(index + 1, nextError));
        Promise.resolve(maybe).then(() => {
          if (index === stack.length - 1) resolve();
        }).catch(reject);
      } catch (err) {
        reject(err);
      }
    };
    dispatch(0);
  });
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

      if (statement.startsWith('SELECT key, value FROM network_settings')) {
        return {
          rows: [
            { key: 'network_enabled', value: 'true' },
            { key: 'profiles_enabled', value: 'true' },
            { key: 'posts_enabled', value: 'true' },
            { key: 'intro_requests_enabled', value: 'true' },
            { key: 'profile_photos_enabled', value: 'true' },
            { key: 'link_previews_enabled', value: 'true' }
          ]
        };
      }

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
  assert.equal(queries.length, 3);
});

test('GET /api/lms/network/profiles espone solo contatti consentiti', async (t) => {
  apiModule.__setPool({
    async query(sql, params = []) {
      assert.deepEqual(params, []);
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      if (statement.startsWith('SELECT key, value FROM network_settings')) {
        return {
          rows: [
            { key: 'network_enabled', value: 'true' },
            { key: 'profiles_enabled', value: 'true' },
            { key: 'posts_enabled', value: 'true' },
            { key: 'intro_requests_enabled', value: 'true' },
            { key: 'profile_photos_enabled', value: 'true' },
            { key: 'link_previews_enabled', value: 'true' }
          ]
        };
      }
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

test('POST /api/lms/network/intro-requests crea una richiesta verso profili disponibili', async (t) => {
  const queries = [];
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ statement, params });

      if (statement.startsWith('SELECT key, value FROM network_settings')) {
        return {
          rows: [
            { key: 'network_enabled', value: 'true' },
            { key: 'profiles_enabled', value: 'true' },
            { key: 'posts_enabled', value: 'true' },
            { key: 'intro_requests_enabled', value: 'true' },
            { key: 'profile_photos_enabled', value: 'true' },
            { key: 'link_previews_enabled', value: 'true' }
          ]
        };
      }

      if (statement.startsWith('SELECT p.user_id FROM network_profiles')) {
        assert.equal(params[0], '22222222-2222-4222-8222-222222222222');
        assert.match(statement, /p\.is_visible = true/);
        assert.match(statement, /p\.available_for_contact = true/);
        return { rows: [{ user_id: params[0] }] };
      }

      if (statement.startsWith('INSERT INTO network_intro_requests')) {
        assert.equal(params[0], '11111111-1111-4111-8111-111111111111');
        assert.equal(params[1], '22222222-2222-4222-8222-222222222222');
        assert.equal(params[2], 'Confrontiamoci su un project work.');
        return {
          rows: [{
            id: 'intro-1',
            status: 'pending',
            message: params[2],
            createdAt: '2026-06-09T12:00:00.000Z',
            updatedAt: '2026-06-09T12:00:00.000Z'
          }]
        };
      }

      if (statement.startsWith('INSERT INTO network_notifications')) {
        assert.equal(params[0], '22222222-2222-4222-8222-222222222222');
        assert.equal(params[1], 'intro_request');
        return { rows: [{ id: 'notif-1' }] };
      }

      throw new Error(`query inattesa: ${statement}`);
    }
  });
  t.after(() => apiModule.__setPool(null));

  const layer = findRoute('/api/lms/network/intro-requests', 'post');
  assert.ok(layer, 'route POST /api/lms/network/intro-requests non trovata');

  const req = {
    method: 'POST',
    url: '/api/lms/network/intro-requests',
    headers: authHeaders(),
    body: {
      recipientUserId: '22222222-2222-4222-8222-222222222222',
      message: 'Confrontiamoci su un project work.'
    }
  };
  const res = createJsonRes();

  await runRoute(layer, req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.status, 'pending');
  assert.equal(queries.length, 4);
});

test('POST /api/lms/network/posts pubblica un post nel feed riservato', async (t) => {
  const queries = [];
  apiModule.__setPool({
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ statement, params });

      if (statement.startsWith('SELECT key, value FROM network_settings')) {
        return {
          rows: [
            { key: 'network_enabled', value: 'true' },
            { key: 'profiles_enabled', value: 'true' },
            { key: 'posts_enabled', value: 'true' },
            { key: 'intro_requests_enabled', value: 'true' },
            { key: 'profile_photos_enabled', value: 'true' },
            { key: 'link_previews_enabled', value: 'true' }
          ]
        };
      }

      if (statement.startsWith('INSERT INTO network_posts')) {
        assert.equal(params[0], '11111111-1111-4111-8111-111111111111');
        assert.equal(params[1], 'Cerco partner per un progetto pilota su MRV.');
        assert.equal(params[2], 'https://example.com/project');
        assert.equal(params[3], 'Scheda progetto');
        assert.equal(params[4], null);
        assert.equal(params[5], null);
        assert.equal(params[6], null);
        assert.equal(params[7], null);
        assert.equal(params[8], null);
        assert.equal(params[9], null);
        assert.deepEqual(params[10], ['MRV', 'Suolo']);
        return {
          rows: [{
            id: 'post-1',
            body: params[1],
            linkUrl: params[2],
            linkTitle: params[3],
            mediaUrl: params[4],
            mediaAlt: params[5],
            linkPreviewTitle: params[6],
            linkPreviewDescription: params[7],
            linkPreviewImageUrl: params[8],
            linkPreviewSiteName: params[9],
            tags: params[10],
            visibility: 'network',
            createdAt: '2026-06-09T12:00:00.000Z',
            updatedAt: '2026-06-09T12:00:00.000Z',
            authorUserId: params[0],
            canDelete: true
          }]
        };
      }

      if (statement.startsWith('SELECT u.first_name AS "authorFirstName"')) {
        return {
          rows: [{
            authorFirstName: 'Ada',
            authorLastName: 'Lovelace',
            authorAvatarUrl: null,
            authorHeadline: 'Carbon project developer',
            authorOrganization: 'Unitus',
            authorRoleTitle: 'Studentessa',
            authorProfilePhotoUrl: 'https://example.com/ada.jpg'
          }]
        };
      }

      throw new Error(`query inattesa: ${statement}`);
    }
  });
  t.after(() => apiModule.__setPool(null));

  const layer = findRoute('/api/lms/network/posts', 'post');
  assert.ok(layer, 'route POST /api/lms/network/posts non trovata');

  const req = {
    method: 'POST',
    url: '/api/lms/network/posts',
    headers: authHeaders(),
    body: {
      body: 'Cerco partner per un progetto pilota su MRV.',
      linkUrl: 'https://example.com/project',
      linkTitle: 'Scheda progetto',
      tags: ['MRV', 'Suolo', 'mrv']
    }
  };
  const res = createJsonRes();

  await runRoute(layer, req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.body, 'Cerco partner per un progetto pilota su MRV.');
  assert.equal(res.body.author.fullName, 'Ada Lovelace');
  assert.equal(res.body.canDelete, true);
  assert.equal(queries.length, 3);
});
