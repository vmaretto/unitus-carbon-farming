const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMetadataBlock, slugify, extractCoverAltFromMediaBlock } = require('../api/seo-helpers');

test('parseMetadataBlock extracts seo fields', () => {
  const meta = parseMetadataBlock(`Data pubblicazione: 17 maggio 2026\nAutore: Mario\nTag: a, b\nSEO title: Titolo seo\nMeta description: Desc\nFocus keyword: carbon farming\nSlug suggerito: Titolo Bello\nPillar slug: Pillar Uno\nCover alt text: Alt immagine`);
  assert.equal(meta.authorName, 'Mario');
  assert.equal(meta.tags.length, 2);
  assert.equal(meta.focusKeyword, 'carbon farming');
  assert.equal(meta.suggestedSlug, 'titolo-bello');
  assert.equal(meta.pillarSlug, 'pillar-uno');
  assert.equal(meta.coverAlt, 'Alt immagine');
  assert.ok(meta.publishedAt instanceof Date);
});

test('slugify normalizes accents', () => {
  assert.equal(slugify('Biochar è utile!'), 'biochar-e-utile');
});

test('extractCoverAltFromMediaBlock finds alt text', () => {
  assert.equal(extractCoverAltFromMediaBlock('Alt text (it): Una cover utile'), 'Una cover utile');
});
