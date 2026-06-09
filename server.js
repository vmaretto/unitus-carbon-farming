const express = require('express');
const path = require('path');
const api = require('./api/index.js');

const app = express();
const rootDir = __dirname;

app.use(express.static(rootDir));

app.use((req, res, next) => {
  const dynamicRoute = req.path === '/api'
    || req.path.startsWith('/api/')
    || req.path === '/share'
    || req.path.startsWith('/share/')
    || req.path === '/sitemap.xml'
    || req.path === '/sitemap'
    || req.path === '/robots.txt'
    || /^\/[a-f0-9]{8,128}\.txt$/i.test(req.path);

  if (!dynamicRoute) return next();
  return api(req, res);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(rootDir, req.path), (err) => {
    if (err) res.status(404).send('Not found');
  });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

module.exports = app;
