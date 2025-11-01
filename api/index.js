// Vercel serverless function that handles all API routes
const handler = require('../server.js');

module.exports = async (req, res) => {
  // Rewrite the URL to remove /api prefix since our Express routes expect /api
  // Vercel will send /api/faculty as req.url, but Express needs it as-is
  return handler(req, res);
};
