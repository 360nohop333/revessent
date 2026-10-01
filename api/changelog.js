// Revessent /api/changelog
// Fully public (no auth) — marketing-facing trust content. Returns the 50 most
// recent changelog entries, newest first.
//
// NOTE: there is intentionally no admin UI for adding entries yet — add them
// directly via Neon's SQL editor:
//   insert into changelog_entries (title, body, published_at)
//   values ('Title', 'Body text…', now());

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let client;

  try {
    client = await pool.connect();
    const result = await client.query(
      `select id, title, body, published_at
         from changelog_entries
        order by published_at desc nulls last, created_at desc nulls last
        limit 50`
    );

    return sendJson(res, 200, {
      entries: result.rows.map((row) => ({
        id: row.id,
        title: row.title || '',
        body: row.body || '',
        publishedAt: toIso(row.published_at),
      })),
    });
  } catch (error) {
    // If the changelog table doesn't exist yet (migration not run), the public
    // page should show its empty state, not an error.
    if (error && error.code === '42P01') {
      return sendJson(res, 200, { entries: [] });
    }

    console.error('Revessent /api/changelog failed:', error);
    return sendJson(res, 500, { error: 'Changelog is not available right now.' });
  } finally {
    if (client) client.release();
  }
};
