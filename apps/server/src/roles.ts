import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import {
  createCore,
  drainOutbox,
  migrationSources,
  pruneOutbox,
  runMigrations,
  testPaymentProvider,
  type CoreDatabase,
  type PaymentProvider,
  type Core,
  type EventHandler,
} from '@trestle/core';
import { buildApp } from './app.js';
import type { Config } from './config.js';

/**
 * Payment providers this deployment registers (ADR 0017). Each is offered only in the channels a
 * merchant enables it for. Gateways such as Stripe will be added here as packages. The test
 * provider moves no money, so it is registered only when the deployment asks for it (ADR 0019).
 */
export function paymentProviders(config: Pick<Config, 'enableTestPaymentProvider'>): PaymentProvider[] {
  return config.enableTestPaymentProvider ? [testPaymentProvider()] : [];
}

/** Event subscribers, by topic. Extensions and webhook delivery will register here (ADR 0008). */
const eventHandlers = new Map<string, EventHandler[]>();

export async function runWeb(db: CoreDatabase, config: Config, logger: Logger, signal: AbortSignal) {
  if (!config.adminApiToken) logger.warn('ADMIN_API_TOKEN is not set; the Admin API will reject every request');
  const core = createCore(db, { paymentProviders: paymentProviders(config) });
  await warnAboutPaymentProviders(core, logger);
  const app = await buildApp({
    core,
    adminApiToken: config.adminApiToken,
    checkReady: async () => void (await sql`select 1`.execute(db)),
    logger,
  });
  await app.listen({ host: config.host, port: config.port });
  await waitFor(signal);
  await app.close();
}

/** Guards that none of the benchmarks have: say loudly when payments may not be real (ADR 0019). */
export async function warnAboutPaymentProviders(core: Pick<Core, 'payments'>, logger: Logger) {
  for (const provider of await core.payments.listProviders()) {
    if (!provider.testMode) continue;
    logger.warn(
      { provider: provider.id, channels: provider.channels.map((c) => c.channelId) },
      'a test payment provider is registered: it moves no money, so never enable it on a live channel',
    );
  }
  for (const { providerId, channelIds } of await core.payments.unregisteredProviders()) {
    logger.warn({ provider: providerId, channels: channelIds }, 'channels enable a payment provider that is not registered; it is not offered');
  }
}

export async function runWorker(db: CoreDatabase, logger: Logger, signal: AbortSignal) {
  logger.info('worker started; delivering outbox events');
  while (!signal.aborted) {
    try {
      const delivered = await drainOutbox(db, eventHandlers);
      if (delivered > 0) {
        logger.info({ delivered }, 'outbox batch delivered');
        continue;
      }
    } catch (error) {
      logger.error({ err: error }, 'outbox batch failed; will retry');
    }
    await sleep(1000, signal);
  }
}

interface ScheduledTask {
  readonly name: string;
  readonly everyMs: number;
  run(db: CoreDatabase): Promise<void>;
}

const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** A completion still running after this long was abandoned (a crash between saga steps). */
const STALE_COMPLETION_MS = 5 * 60 * 1000;
/** An immediate capture still missing this long after the payment last changed is retried. */
const CAPTURE_RETRY_MS = 5 * 60 * 1000;
/** How far ahead to warn that an authorization lapses (ADR 0019). */
const EXPIRY_WARNING_MS = 48 * 60 * 60 * 1000;

function scheduledTasks(config: Pick<Config, 'enableTestPaymentProvider'>): ScheduledTask[] {
  const core = (db: CoreDatabase) => createCore(db, { paymentProviders: paymentProviders(config) });
  return [
    {
      name: 'outbox.prune',
      everyMs: 60 * 60 * 1000,
      run: async (db) => void (await pruneOutbox(db, new Date(Date.now() - OUTBOX_RETENTION_MS))),
    },
    {
      name: 'checkout.recover-stale',
      everyMs: 60 * 1000,
      run: async (db) => void (await core(db).checkout.recoverStale(new Date(Date.now() - STALE_COMPLETION_MS))),
    },
    {
      name: 'checkout.capture-due',
      everyMs: 60 * 1000,
      run: async (db) => void (await core(db).checkout.captureDue(new Date(Date.now() - CAPTURE_RETRY_MS))),
    },
    {
      name: 'payments.warn-expiring',
      everyMs: 15 * 60 * 1000,
      run: async (db) => void (await core(db).payments.warnExpiringAuthorizations(new Date(Date.now() + EXPIRY_WARNING_MS))),
    },
  ];
}

/** Leader-elected through a Postgres advisory lock, so running several schedulers is safe. */
const SCHEDULER_LOCK = 4_242_002;

export async function runScheduler(db: CoreDatabase, config: Config, logger: Logger, signal: AbortSignal) {
  const tasks = scheduledTasks(config);
  await db.connection().execute(async (conn) => {
    while (!signal.aborted) {
      const { rows } = await sql<{ locked: boolean }>`select pg_try_advisory_lock(${SCHEDULER_LOCK}) as locked`.execute(conn);
      if (rows[0]?.locked) break;
      logger.info('another scheduler is active; standing by');
      await sleep(15_000, signal);
    }
    if (signal.aborted) return;
    logger.info({ tasks: tasks.map((t) => t.name) }, 'scheduler is the leader');

    const nextRun = new Map(tasks.map((t) => [t.name, 0]));
    while (!signal.aborted) {
      for (const task of tasks) {
        if (Date.now() < nextRun.get(task.name)!) continue;
        nextRun.set(task.name, Date.now() + task.everyMs);
        try {
          await task.run(db);
          logger.info({ task: task.name }, 'scheduled task finished');
        } catch (error) {
          logger.error({ err: error, task: task.name }, 'scheduled task failed');
        }
      }
      await sleep(1000, signal);
    }
    await sql`select pg_advisory_unlock(${SCHEDULER_LOCK})`.execute(conn);
  });
}

export async function runMigrate(db: CoreDatabase, logger: Logger) {
  const applied = await runMigrations(db, migrationSources);
  logger.info({ applied: applied.map((m) => `${m.module}/${m.id}`) }, `${applied.length} migration(s) applied`);
}

/** Writes both OpenAPI documents without touching the database (the pool connects lazily). */
export async function writeOpenApi(db: CoreDatabase, outDir: string, logger: Logger) {
  const app = await buildApp({ core: createCore(db), adminApiToken: undefined, checkReady: async () => {} });
  await app.ready();
  await mkdir(outDir, { recursive: true });
  for (const api of ['store', 'admin'] as const) {
    const res = await app.inject({ url: `/${api}/v1/openapi.json` });
    const file = join(outDir, `${api}.json`);
    await writeFile(file, `${JSON.stringify(res.json(), null, 2)}\n`);
    logger.info({ file }, 'OpenAPI document written');
  }
  await app.close();
}

function waitFor(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}
