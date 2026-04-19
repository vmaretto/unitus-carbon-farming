const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseBlogPostsFromDocxBuffer, parseBlogPostsFromHtml } = require('../api/blog-import');

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

test('parseBlogPostsFromHtml gestisce metadati e prompt AI compattati nella stessa cella/riga', () => {
  const html = `
    <p>ARTICOLO 1/1</p>
    <h1>Test parser compatto</h1>
    <p>METADATI ARTICOLO</p>
    <table>
      <tr>
        <td>Data pubblicazione: 19 aprile 2026 Autore: Redazione Master Carbon Farming Tag: policy, ai, blog Modulo del master collegato: M2 - Policy</td>
      </tr>
    </table>
    <h3>Abstract (per card lista blog)</h3>
    <p><em>Abstract di test.</em></p>
    <h3>Corpo articolo</h3>
    <p>Contenuto di prova.</p>
    <h3>Media suggeriti (immagini &amp; video)</h3>
    <table>
      <tr>
        <td>Immagine di copertina (AI): cover editoriale Prompt AI: paesaggio agricolo con dati climatici</td>
      </tr>
    </table>
    <h3>Fonti da linkare nell'articolo</h3>
    <p><a href="https://example.com/fonte">Fonte</a></p>
  `;

  const result = parseBlogPostsFromHtml(html, {
    now: new Date('2026-04-19T08:00:00.000Z')
  });

  assert.equal(result.posts.length, 1);
  assert.deepEqual(result.posts[0].tags, ['policy', 'ai', 'blog']);
  assert.equal(result.posts[0].publishedAt, '2026-04-19T09:00:00.000Z');
  assert.equal(result.posts[0].sourceModule, 'M2 - Policy');
  assert.equal(result.posts[0].coverImagePrompt, 'paesaggio agricolo con dati climatici');
});

test('parseBlogPostsFromDocxBuffer usa il fallback raw docx quando metadata e prompt non emergono bene dall HTML', async () => {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>ARTICOLO 1/1</w:t></w:r></w:p>
        <w:p><w:r><w:t>Articolo fallback</w:t></w:r></w:p>
        <w:p><w:r><w:t>METADATI ARTICOLO</w:t></w:r></w:p>
        <w:p><w:r><w:t>Data pubblicazione: 19 aprile 2026</w:t></w:r></w:p>
        <w:p><w:r><w:t>Tag: carbon farming, policy</w:t></w:r></w:p>
        <w:p><w:r><w:t>Modulo del master collegato: M2 - Policy</w:t></w:r></w:p>
        <w:p><w:r><w:t>Abstract (per card lista blog)</w:t></w:r></w:p>
        <w:p><w:r><w:t>Estratto breve.</w:t></w:r></w:p>
        <w:p><w:r><w:t>Corpo articolo</w:t></w:r></w:p>
        <w:p><w:r><w:t>Contenuto body.</w:t></w:r></w:p>
        <w:p><w:r><w:t>Media suggeriti (immagini &amp; video)</w:t></w:r></w:p>
        <w:p><w:r><w:t>Prompt AI: paesaggio agricolo editoriale</w:t></w:r></w:p>
        <w:sectPr/>
      </w:body>
    </w:document>`
  );

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const result = await parseBlogPostsFromDocxBuffer(buffer, {
    now: new Date('2026-04-19T08:00:00.000Z')
  });

  assert.equal(result.posts.length, 1);
  assert.deepEqual(result.posts[0].tags, ['carbon farming', 'policy']);
  assert.equal(result.posts[0].sourceModule, 'M2 - Policy');
  assert.equal(result.posts[0].coverImagePrompt, 'paesaggio agricolo editoriale');
});
