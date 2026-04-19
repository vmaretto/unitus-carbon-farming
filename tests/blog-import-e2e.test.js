const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { FakeBlogPool, tinyPngBase64 } = require('./helpers');

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin-password';
process.env.MOCK_OPENAI_IMAGE_BASE64 = process.env.MOCK_OPENAI_IMAGE_BASE64 || tinyPngBase64();

const apiModule = require('../api/index.js');

test('import workflow crea 5 bozze e valorizza la cover AI sul post richiesto', async (t) => {
  const pool = new FakeBlogPool();
  apiModule.__setPool(pool);
  t.after(() => apiModule.__setPool(null));

  const fixturePath = path.join(__dirname, 'fixtures', 'blog_sample.docx');
  const buffer = fs.readFileSync(fixturePath);

  const importResult = await apiModule.__importBlogPostsFromDocxBufferIntoDatabase(buffer, {
    now: new Date('2026-04-19T08:00:00.000Z')
  });

  assert.equal(importResult.imported, 5);
  assert.equal(pool.posts.length, 5);
  assert.ok(pool.posts.every((post) => post.is_published === false));

  const firstPostId = importResult.posts[0].id;
  const coverResult = await apiModule.__generateCoverForBlogPost(firstPostId);

  assert.equal(coverResult.reused, false);
  assert.match(coverResult.coverImageUrl, /^\/uploads\/blog-covers\//);

  const storedPost = pool.posts.find((post) => post.id === firstPostId);
  assert.equal(storedPost.cover_image_url, coverResult.coverImageUrl);
});
