export * from './kernel/money.js';
export * from './kernel/state-machine.js';
export * from './kernel/totals.js';
export * from './kernel/result.js';
export { newId } from './kernel/id.js';
export { createDatabase, type CoreDatabase, type DatabaseOptions } from './kernel/db.js';
export { defineModule, type Migration, type MigrationSource, type ModuleDefinition } from './kernel/module.js';
export { runMigrations, type AppliedMigration } from './kernel/migrator.js';
export {
  drainOutbox,
  pruneOutbox,
  recordEvent,
  type EventHandler,
  type OutboxEvent,
} from './kernel/outbox.js';

export * from './modules/cart/index.js';
export * from './modules/catalog/index.js';
export * from './modules/channel/index.js';
export * from './modules/checkout/index.js';
export * from './modules/orders/index.js';
export * from './modules/payments/index.js';
export * from './modules/pricing/index.js';
export * from './modules/shipping/index.js';

export { createCore, migrationSources, type Core, type CoreOptions } from './core.js';
