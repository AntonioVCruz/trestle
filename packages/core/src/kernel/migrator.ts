import { sql } from 'kysely';
import type { CoreDatabase } from './db.js';
import { validateMigrations, type MigrationSource } from './module.js';

/** Fixed advisory-lock key so concurrent `migrate` runs (e.g. several deploy jobs) serialize. */
const MIGRATION_LOCK = 4_242_001;

export interface AppliedMigration {
  readonly module: string;
  readonly id: string;
}

/**
 * Applies pending migrations, module by module in the given order, each in its own
 * transaction. Runs as the one-shot `migrate` role, never implicitly on web start.
 */
export async function runMigrations(
  db: CoreDatabase,
  sources: readonly MigrationSource[],
): Promise<AppliedMigration[]> {
  sources.forEach(validateMigrations);
  const applied: AppliedMigration[] = [];

  await db.connection().execute(async (conn) => {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK})`.execute(conn);
    try {
      await sql`
        create table if not exists _migration (
          module text not null,
          id text not null,
          applied_at timestamptz not null default now(),
          primary key (module, id)
        )
      `.execute(conn);

      const done = await sql<AppliedMigration>`select module, id from _migration`.execute(conn);
      const doneKeys = new Set(done.rows.map((row) => `${row.module}/${row.id}`));

      for (const source of sources) {
        for (const migration of source.migrations) {
          if (doneKeys.has(`${source.name}/${migration.id}`)) continue;
          await conn.transaction().execute(async (trx) => {
            await sql.raw(migration.sql).execute(trx);
            await sql`insert into _migration (module, id) values (${source.name}, ${migration.id})`.execute(trx);
          });
          applied.push({ module: source.name, id: migration.id });
        }
      }
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK})`.execute(conn);
    }
  });

  return applied;
}
