const test = require('node:test');
const assert = require('node:assert/strict');

const apiModule = require('../api/index.js');

function findGetRoute(path) {
  return apiModule.app._router.stack.find((entry) => {
    return entry?.route?.path === path && entry.route.methods.get;
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
