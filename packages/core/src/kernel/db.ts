import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

/**
 * The shared database handle knows no tables. Each module narrows it to the tables it owns
 * with `db.withTables<ModuleTables>()`, so reaching into another module's tables is a type
 * error, not a code-review catch (ADR 0002).
 */
export type CoreDatabase = Kysely<{}>;

export interface DatabaseOptions {
  readonly maxConnections?: number;
}

export function createDatabase(connectionString: string, options: DatabaseOptions = {}): CoreDatabase {
  const pool = new pg.Pool({ connectionString, max: options.maxConnections ?? 10 });
  return new Kysely<{}>({ dialect: new PostgresDialect({ pool }) });
}

/** Postgres unique_violation, e.g. a duplicate channel code; optionally of one named constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== '23505') return false;
  return constraint === undefined || ('constraint' in error && error.constraint === constraint);
}
