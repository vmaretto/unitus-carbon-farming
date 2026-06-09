const express = require('express');
const api = require('./api/index.js');

const app = express();

app.use((req, res) => {
  return api(req, res);
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

module.exports = app;
