import type { CoreDatabase } from './db.js';

/** A forward-only SQL migration. Ids sort lexically: `0001_create_channel`. */
export interface Migration {
  readonly id: string;
  readonly sql: string;
}

export interface MigrationSource {
  readonly name: string;
  readonly migrations: readonly Migration[];
}

/**
 * A commerce module owns its tables, migrations and service (ADR 0002). Other modules talk to
 * it only through the service it exports or the events it records, never through its tables.
 * A module that needs another module declares what it needs as `Deps` (its own interfaces);
 * the composition root supplies them.
 */
export interface ModuleDefinition<Name extends string, Service, Deps = void> extends MigrationSource {
  readonly name: Name;
  createService(db: CoreDatabase, deps: Deps): Service;
}

const MODULE_NAME = /^[a-z][a-z0-9_]*$/;
const MIGRATION_ID = /^\d{4}_[a-z0-9_]+$/;

export function validateMigrations(source: MigrationSource): void {
  let previous = '';
  for (const { id } of source.migrations) {
    if (!MIGRATION_ID.test(id)) throw new Error(`${source.name}: invalid migration id "${id}"`);
    if (id <= previous) throw new Error(`${source.name}: migration "${id}" is out of order or duplicated`);
    previous = id;
  }
}

export function defineModule<const Name extends string, Service, Deps = void>(
  definition: ModuleDefinition<Name, Service, Deps>,
): ModuleDefinition<Name, Service, Deps> {
  if (!MODULE_NAME.test(definition.name)) throw new Error(`Invalid module name "${definition.name}"`);
  validateMigrations(definition);
  return Object.freeze(definition);
}
