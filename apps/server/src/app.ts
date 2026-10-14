import Fastify, { type FastifyBaseLogger } from 'fastify';
import { adminApi } from '@trestle/api-admin';
import { storeApi } from '@trestle/api-store';
import type { Core } from '@trestle/core';

export interface AppOptions {
  readonly core: Core;
  readonly adminApiToken: string | undefined;
  /** Throws when a dependency (the database) is unavailable. */
  readonly checkReady: () => Promise<void>;
  /** Shared pino instance; omitted in tests. */
  readonly logger?: FastifyBaseLogger;
}

/** The `web` role: both APIs in one process, isolated in separate Fastify contexts. */
export async function buildApp(opts: AppOptions) {
  const app = opts.logger ? Fastify({ loggerInstance: opts.logger }) : Fastify();

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (request, reply) => {
    try {
      await opts.checkReady();
      return { status: 'ok' };
    } catch (error) {
      request.log.warn({ err: error }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  await app.register(storeApi, {
    prefix: '/store/v1',
    channels: opts.core.channel,
    catalog: opts.core.catalog,
    pricing: opts.core.pricing,
    carts: opts.core.cart,
    checkout: opts.core.checkout,
    orders: opts.core.orders,
  });
  await app.register(adminApi, {
    prefix: '/admin/v1',
    channels: opts.core.channel,
    catalog: opts.core.catalog,
    pricing: opts.core.pricing,
    shipping: opts.core.shipping,
    payments: opts.core.payments,
    orders: opts.core.orders,
    token: opts.adminApiToken,
  });

  return app;
}
