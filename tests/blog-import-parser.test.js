const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseBlogPostsFromDocxBuffer } = require('../api/blog-import');

test('parseBlogPostsFromDocxBuffer estrae 5 articoli dal fixture Word', async () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'blog_sample.docx');
  const buffer = fs.readFileSync(fixturePath);

  const result = await parseBlogPostsFromDocxBuffer(buffer, {
    now: new Date('2026-04-19T08:00:00.000Z')
  });

  assert.equal(result.posts.length, 5);
  assert.equal(result.posts[0].title, 'Nuove regole UE sul Carbon Farming');
  assert.equal(result.posts[0].slug, 'nuove-regole-ue-sul-carbon-farming');
  assert.match(result.posts[0].excerpt, /certificazione europea/i);
  assert.deepEqual(result.posts[0].tags, ['policy', 'eu', 'carbon farming']);
  assert.equal(result.posts[0].author, 'Redazione Master Carbon Farming');
  assert.equal(result.posts[0].sourceModule, 'M2 - Politiche e mercati del carbonio');
  assert.match(result.posts[0].coverImagePrompt, /campi agricoli europei/i);
  assert.equal(result.posts[0].sources.length, 2);
  assert.equal(result.posts[0].sources[0].url, 'https://climate.ec.europa.eu/eu-action/carbon-farming_en');
  assert.ok(result.posts[0].content.includes('<h2>Perche conta adesso</h2>'));
  assert.ok(Array.isArray(result.conversionMessages));
});
