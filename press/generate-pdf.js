const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ 
    headless: 'new',
    args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  await page.goto('file:///Users/virgiliomaretto/clawd/projects/unitus-carbon-farming/press/infografica-carbon-farming.html', { waitUntil: 'networkidle0' });
  await page.pdf({
    path: 'infografica-carbon-farming.pdf',
    format: 'A4',
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  await browser.close();
  console.log('PDF created!');
})();
