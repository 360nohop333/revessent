// Revessent /api/leads (audit #47) — public lead capture for the landing
// page's "Start free pilot" forms. Previously those forms showed "You're on
// the list" while sending nothing. Rate-limited at the router (public POST).

const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1, // audit #45: single connection per serverless instance
  ssl: { rejectUnauthorized: false },
});

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  if (Buffer.isBuffer(req.body)) {
    const raw = req.body.toString('utf8');
    return raw ? JSON.parse(raw) : {};
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  try {
    const body = await readJsonBody(req);
    const email = String((body && body.email) || '').trim().toLowerCase().slice(0, 200);
    const source = String((body && body.source) || '').trim().slice(0, 60);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendJson(res, 400, { error: 'A valid email is required.' });
    }

    await pool.connect().then(async (client) => {
      try {
        await client.query(
          `insert into leads (id, email, source, created_at) values ($1, $2, $3, now())`,
          [crypto.randomUUID(), email, source || 'landing']
        );
      } finally {
        client.release();
      }
    });

    return sendJson(res, 200, { success: true });
  } catch (error) {
    console.error('Revessent /api/leads failed:', error);
    return sendJson(res, 500, { error: 'Could not save your request right now. Please email hello@revessent.com.' });
  }
};
