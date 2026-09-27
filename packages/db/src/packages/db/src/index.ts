// revessent/packages/db/src/index.ts
// Database client — connects to Neon PostgreSQL via Drizzle ORM

import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

// ─── Create DB client ──────────────────────────────────────────────────────────

function createDb(connectionString: string) {
  const sql = neon(connectionString);
  return drizzle(sql, { schema });
}

// App role (row-level, tenant-scoped)
export const db = createDb(
  process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL!
);

// Re-export schema so importers only need one package
export * from "./schema";
export { schema };
export type Db = typeof db;
