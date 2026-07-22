const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const homepage = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('le sezioni molto alte diventano visibili appena entrano nel viewport', () => {
  const observerOptions = homepage.match(
    /const observerOptions\s*=\s*\{[\s\S]*?threshold:\s*([\d.]+)/
  );

  assert.ok(observerOptions, 'Configurazione IntersectionObserver non trovata');
  assert.ok(
    Number(observerOptions[1]) <= 0.01,
    'La soglia deve restare raggiungibile anche per sezioni più alte del viewport'
  );
});
