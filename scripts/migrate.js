#!/usr/bin/env node
// Revessent migration runner (audit #41).
//
// Applies pending ./migrations/*.sql files in filename order, tracking them
// in a `_migrations` table. Each file runs in its own transaction — a failed
// file rolls back cleanly and the run stops there.
//
// Usage:   DATABASE_URL=postgres://… node scripts/migrate.js
// (Or `npm run migrate` — but export DATABASE_URL first; this script NEVER
// reads .env files, only real environment variables.)
//
// This script is deliberately dumb: no templating, no down-migrations.
// Reverse a migration by writing a new forward one, like every grown-up.

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set — nothing to do.');
    process.exit(1);
  }

  const { Client } = require('pg');
  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (!files.length) {
    console.log('No migration files found.');
    return;
  }

  await client.connect();

  try {
    await client.query(
      `create table if not exists _migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`
    );

    const { rows } = await client.query('select name from _migrations');
    const applied = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (applied.has(file)) {
        console.log('·', file, '— already applied');
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log('→', file, '…');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('insert into _migrations (name) values ($1)', [file]);
        await client.query('COMMIT');
        console.log('✔', file, 'applied');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('✘', file, 'FAILED — rolled back. Fix and re-run.');
        console.error(error.message);
        process.exitCode = 1;
        break;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Migration runner crashed:', error);
  process.exit(1);
});
