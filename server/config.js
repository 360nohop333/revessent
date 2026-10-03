// Revessent /api/config.js (audit #66) — serves as a tiny JavaScript file so
// every page can <script src="/api/config.js"> and pick up the Supabase
// project from env vars WITHOUT a rebuild.
//
// The anon/publishable key is public by design; nothing sensitive is exposed here.

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.statusCode = 405;
    return res.end();
  }

  const url = process.env.SUPABASE_URL || '';
  const anonKey = process.env.SUPABASE_ANON_KEY || '';

  // Values are JSON-embedded so no quoting/escaping games are possible.
  const js = 'window.REVESSENT_SUPABASE_CONFIG = ' + JSON.stringify({ url, anonKey }) + ';';

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(js);
};
