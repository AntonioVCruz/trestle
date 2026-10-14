import { pino } from 'pino';
import { createDatabase } from '@trestle/core';
import { loadConfig } from './config.js';
import { runMigrate, runScheduler, runWeb, runWorker, writeOpenApi } from './roles.js';

/**
 * One image, several process roles (ADR 0009):
 *   web        Store API + Admin API
 *   worker     delivers outbox events (and, later, jobs)
 *   scheduler  runs periodic tasks; leader-elected
 *   migrate    applies pending migrations, then exits
 *   openapi    writes openapi/{store,admin}.json, then exits
 */
const ROLES = ['web', 'worker', 'scheduler', 'migrate', 'openapi'] as const;
type Role = (typeof ROLES)[number];

const role = process.argv[2] as Role | undefined;
if (!role || !ROLES.includes(role)) {
  console.error(`usage: main.js <${ROLES.join('|')}> [args]`);
  process.exit(64);
}

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { role } });

if (role === 'openapi') {
  const db = createDatabase('postgres://unused@localhost/unused');
  await writeOpenApi(db, process.argv[3] ?? 'openapi', logger);
  await db.destroy();
  process.exit(0);
}

const config = loadConfig();
const db = createDatabase(config.databaseUrl);
const shutdown = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    logger.info({ signal: sig }, 'shutting down');
    shutdown.abort();
  });
}

try {
  switch (role) {
    case 'web':
      await runWeb(db, config, logger, shutdown.signal);
      break;
    case 'worker':
      await runWorker(db, logger, shutdown.signal);
      break;
    case 'scheduler':
      await runScheduler(db, config, logger, shutdown.signal);
      break;
    case 'migrate':
      await runMigrate(db, logger);
      break;
  }
} catch (error) {
  logger.fatal({ err: error }, 'process failed');
  process.exitCode = 1;
} finally {
  await db.destroy();
}
