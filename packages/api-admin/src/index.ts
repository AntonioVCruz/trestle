import { timingSafeEqual } from 'node:crypto';
import swagger from '@fastify/swagger';
import type { FastifyError } from 'fastify';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type {
  CatalogService,
  ChannelService,
  CreateChannelError,
  OrderService,
  PaymentsService,
  PricingService,
  ShippingService,
} from '@trestle/core';
import { catalogRoutes } from './catalog.js';
import { orderRoutes, orderSchemas } from './orders.js';
import { paymentsRoutes, paymentsSchemas } from './payments.js';
import { pricingRoutes } from './pricing.js';
import { shippingRoutes } from './shipping.js';
import {
  catalogSchemas,
  ChannelListSchema,
  ChannelSchema,
  CreateChannelSchema,
  errorBody,
  ErrorSchema,
  pricingSchemas,
  PublishableKeySchema,
  shippingSchemas,
  toChannelDto,
  toPublishableKeyDto,
} from './schemas.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Route skips API authentication (e.g. the OpenAPI document). */
    public?: boolean;
  }
}

export interface AdminApiOptions {
  readonly channels: ChannelService;
  readonly catalog: CatalogService;
  readonly pricing: PricingService;
  readonly shipping: ShippingService;
  readonly payments: PaymentsService;
  readonly orders: Pick<OrderService, 'getOrder' | 'listOrders'>;
  /**
   * Bootstrap bearer token. Stand-in until admin users, sessions and RBAC exist; when it is
   * not configured every request is rejected rather than left open.
   */
  readonly token: string | undefined;
}

const CREATE_CHANNEL_STATUS: Record<CreateChannelError['code'], 400 | 409> = {
  invalid_input: 400,
  channel_code_taken: 409,
};

/**
 * Admin API (ADR 0003). Separate authentication, schema and OpenAPI document from the Store
 * API. Register it under a versioned prefix, e.g. `/admin/v1`.
 */
export const adminApi: FastifyPluginAsyncTypebox<AdminApiOptions> = async (app, opts) => {
  await app.register(swagger, {
    // Name shared schemas after their $id in components.schemas.
    refResolver: { buildLocalReference: (json, _baseUri, _fragment, i) => (json.$id as string | undefined) ?? `def-${i}` },
    openapi: {
      info: { title: 'Trestle Admin API', version: '1.0.0' },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
    },
  });
  const channelSchemas = [ChannelSchema, ChannelListSchema, CreateChannelSchema, PublishableKeySchema];
  for (const schema of [ErrorSchema, ...channelSchemas, ...catalogSchemas, ...pricingSchemas, ...shippingSchemas, ...paymentsSchemas, ...orderSchemas]) {
    app.addSchema(schema);
  }

  const expected = opts.token ? Buffer.from(opts.token) : undefined;
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.config.public) return;
    const header = request.headers.authorization;
    const given = header?.startsWith('Bearer ') ? Buffer.from(header.slice('Bearer '.length)) : undefined;
    if (!expected || !given || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.code(401).send(errorBody('unauthorized', 'A valid bearer token is required'));
    }
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) return reply.code(400).send(errorBody('invalid_request', error.message));
    // Fastify's own client errors, such as an empty body sent as JSON.
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send(errorBody('invalid_request', error.message));
    }
    request.log.error(error);
    return reply.code(500).send(errorBody('internal_error', 'Internal server error'));
  });

  app.get('/openapi.json', { config: { public: true }, schema: { hide: true } }, async () => app.swagger());

  app.get(
    '/channels',
    {
      schema: {
        operationId: 'listChannels',
        tags: ['channel'],
        response: { 200: ChannelListSchema, 401: ErrorSchema },
      },
    },
    async () => ({ data: (await opts.channels.list()).map(toChannelDto) }),
  );

  app.post(
    '/channels',
    {
      schema: {
        operationId: 'createChannel',
        tags: ['channel'],
        body: CreateChannelSchema,
        response: { 201: ChannelSchema, 400: ErrorSchema, 401: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (request, reply) => {
      const result = await opts.channels.create(request.body);
      if (!result.ok) {
        return reply
          .code(CREATE_CHANNEL_STATUS[result.error.code])
          .send(errorBody(result.error.code, result.error.message));
      }
      return reply.code(201).send(toChannelDto(result.value));
    },
  );

  app.post(
    '/channels/:id/publishable-keys',
    {
      schema: {
        operationId: 'createPublishableKey',
        tags: ['channel'],
        params: Type.Object({ id: Type.String() }),
        response: { 201: PublishableKeySchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const result = await opts.channels.createPublishableKey(request.params.id);
      if (!result.ok) {
        return reply.code(404).send(errorBody(result.error.code, result.error.message));
      }
      return reply.code(201).send(toPublishableKeyDto(result.value));
    },
  );

  await app.register(catalogRoutes, { catalog: opts.catalog, channels: opts.channels });
  await app.register(pricingRoutes, { pricing: opts.pricing, catalog: opts.catalog, channels: opts.channels });
  await app.register(shippingRoutes, { shipping: opts.shipping, channels: opts.channels });
  await app.register(paymentsRoutes, { payments: opts.payments, channels: opts.channels });
  await app.register(orderRoutes, { orders: opts.orders, payments: opts.payments });
};
