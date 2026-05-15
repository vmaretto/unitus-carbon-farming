const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { FakeBlogPool } = require('./helpers');

process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://unitus.carbonfarmingmaster.it';

const apiModule = require('../api/index.js');

function startServer(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

test('share page espone meta OG e cover per LinkedIn', async (t) => {
  const pool = new FakeBlogPool();
  apiModule.__setPool(pool);
  t.after(() => apiModule.__setPool(null));

  pool.posts.push({
    id: 'blog-share-1',
    title: 'Articolo per LinkedIn',
    slug: 'articolo-linkedin',
    excerpt: 'Un estratto breve per testare la card di condivisione.',
    content: '<p>Contenuto di prova.</p>',
    cover_image_url: '/uploads/blog-covers/test-share.png',
    published_at: '2026-05-15T08:00:00.000Z',
    is_published: true,
    source_module: 'M11 - Casi Studio e Applicazioni',
    sources: [{ title: 'Fonte 1', url: 'https://example.com/fonte-1' }]
  });

  const { server, port } = await startServer(apiModule.app);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/share/blog/articolo-linkedin`);
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /og:title" content="Articolo per LinkedIn"/);
  assert.match(html, /og:image" content="https:\/\/unitus\.carbonfarmingmaster\.it\/uploads\/blog-covers\/test-share\.png"/);
  assert.match(html, /linkedin\.com\/sharing\/share-offsite/);
  assert.match(html, /Leggi l'articolo/);
});
