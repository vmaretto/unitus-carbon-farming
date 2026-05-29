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

class FakePartnerPool {
  constructor() {
    this.partners = [{
      id: 'partner-1',
      name: 'ROMA CAPITALE',
      logo_url: 'https://example.com/logo.png',
      partner_type: 'patrocinio',
      description: 'Descrizione precedente',
      website_url: 'https://www.comune.roma.it',
      sort_order: 1,
      is_published: true
    }];
  }

  async query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('UPDATE partners SET')) {
      const whereMatch = normalized.match(/WHERE id = \$(\d+)/i);
      const id = whereMatch ? params[Number(whereMatch[1]) - 1] : params[params.length - 1];
      const row = this.partners.find((partner) => partner.id === id);
      if (!row) return { rows: [] };

      const setPart = normalized.split(' WHERE ')[0].replace('UPDATE partners SET ', '');
      const assignments = setPart.split(',').map((item) => item.trim()).filter((item) => item !== 'updated_at = NOW()');
      assignments.forEach((assignment) => {
        const match = assignment.match(/^([a-z_]+) = \$(\d+)$/i);
        if (!match) return;
        row[match[1]] = params[Number(match[2]) - 1];
      });
      return { rows: [{ ...row }] };
    }

    throw new Error(`Unsupported query in FakePartnerPool: ${normalized}`);
  }
}

test('PUT /api/partners/:id aggiorna la descrizione del partner', async (t) => {
  const pool = new FakePartnerPool();
  apiModule.__setPool(pool);
  t.after(() => {
    apiModule.__setPool(null);
  });

  const layer = findRoute('/api/partners/:id', 'put');
  assert.ok(layer, 'route /api/partners/:id non trovata');

  const req = {
    method: 'PUT',
    url: '/api/partners/partner-1',
    params: { id: 'partner-1' },
    body: {
      description: 'Nuova descrizione istituzionale del patrocinio.'
    },
    headers: {}
  };
  const res = createRes();

  await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.description, 'Nuova descrizione istituzionale del patrocinio.');
  assert.equal(pool.partners[0].description, 'Nuova descrizione istituzionale del patrocinio.');
});
