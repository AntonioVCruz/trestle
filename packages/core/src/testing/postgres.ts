import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrationSources } from '../core.js';
import type { CoreDatabase } from '../kernel/db.js';
import { runMigrations } from '../kernel/migrator.js';

/**
 * Integration tests run against the Postgres in `TEST_DATABASE_URL` and are skipped without it
 * (ADR 0011). Each suite migrates a fresh, randomly named schema and drops it afterwards, so it
 * never touches other data in that database.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export interface TestDatabase {
  readonly db: CoreDatabase;
  /** Queries executed since the last `resetQueryCount()`. */
  queryCount(): number;
  resetQueryCount(): void;
  destroy(): Promise<void>;
}

export async function createTestDatabase(connectionString = TEST_DATABASE_URL): Promise<TestDatabase> {
  if (!connectionString) throw new Error('TEST_DATABASE_URL is not set');
  const schema = `test_${randomBytes(6).toString('hex')}`;

  const admin = new pg.Client({ connectionString });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  await admin.end();

  let queries = 0;
  const db = new Kysely<{}>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 }),
    }),
    log: (event) => {
      if (event.level === 'query') queries++;
    },
  });
  await runMigrations(db, migrationSources);
  queries = 0;

  return {
    db,
    queryCount: () => queries,
    resetQueryCount: () => void (queries = 0),
    async destroy() {
      await sql.raw(`drop schema ${schema} cascade`).execute(db);
      await db.destroy();
    },
  };
}
