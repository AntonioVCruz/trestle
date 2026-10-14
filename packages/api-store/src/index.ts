import swagger from '@fastify/swagger';
import type { FastifyError } from 'fastify';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type {
  CartService,
  CatalogService,
  Channel,
  ChannelService,
  CheckoutService,
  OrderService,
  PricingService,
  Product,
} from '@trestle/core';
import { cartRoutes } from './cart.js';
import { orderRoutes } from './orders.js';
import {
  AddCartLineSchema,
  CreateCartSchema,
  DEFAULT_PAGE_SIZE,
  errorBody,
  ErrorSchema,
  GetStoreProductQuerySchema,
  ListStoreProductsQuerySchema,
  SelectPaymentMethodSchema,
  SelectShippingMethodSchema,
  SetCartAddressesSchema,
  StoreAddressSchema,
  StoreCartLineSchema,
  StoreCartSchema,
  StoreCategoryListSchema,
  StoreCategorySchema,
  StoreChannelSchema,
  StoreOrderSchema,
  StorePaymentMethodListSchema,
  StorePaymentMethodSchema,
  StorePriceSchema,
  StoreProductOptionSchema,
  StoreProductPageSchema,
  StoreProductSchema,
  StoreSelectedPaymentSchema,
  StoreShippingQuoteListSchema,
  StoreShippingQuoteSchema,
  StoreVariantSchema,
  toStoreCategory,
  toStoreChannel,
  toStoreProduct,
  UpdateCartLineSchema,
} from './schemas.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the Store API from the `x-publishable-key` header. */
    channel: Channel | null;
  }
  interface FastifyContextConfig {
    /** Route skips API authentication (e.g. the OpenAPI document). */
    public?: boolean;
  }
}

export const PUBLISHABLE_KEY_HEADER = 'x-publishable-key';

export interface StoreApiOptions {
  readonly channels: Pick<ChannelService, 'getByPublishableKey'>;
  readonly catalog: Pick<CatalogService, 'listProducts' | 'getProductByHandle' | 'listCategories' | 'getCategoryByHandle'>;
  readonly pricing: Pick<PricingService, 'resolvePrices'>;
  readonly carts: CartService;
  readonly checkout: Pick<CheckoutService, 'completeCart'>;
  readonly orders: Pick<OrderService, 'getOrder'>;
}

/**
 * Store API (ADR 0003). Public and channel-scoped: every request names its channel with a
 * publishable key (ADR 0004). Register it under a versioned prefix, e.g. `/store/v1`.
 * It owns its OpenAPI document; nothing from the Admin API leaks into it.
 */
export const storeApi: FastifyPluginAsyncTypebox<StoreApiOptions> = async (app, opts) => {
  await app.register(swagger, {
    // Name shared schemas after their $id in components.schemas.
    refResolver: { buildLocalReference: (json, _baseUri, _fragment, i) => (json.$id as string | undefined) ?? `def-${i}` },
    openapi: {
      info: { title: 'Trestle Store API', version: '1.0.0' },
      components: {
        securitySchemes: {
          publishableKey: { type: 'apiKey', in: 'header', name: PUBLISHABLE_KEY_HEADER },
        },
      },
      security: [{ publishableKey: [] }],
    },
  });
  for (const schema of [
    ErrorSchema,
    StoreChannelSchema,
    StorePriceSchema,
    StoreProductOptionSchema,
    StoreVariantSchema,
    StoreProductSchema,
    StoreProductPageSchema,
    StoreCategorySchema,
    StoreCategoryListSchema,
    StoreCartLineSchema,
    StoreCartSchema,
    CreateCartSchema,
    AddCartLineSchema,
    UpdateCartLineSchema,
    StoreAddressSchema,
    StoreShippingQuoteSchema,
    StoreShippingQuoteListSchema,
    SetCartAddressesSchema,
    SelectShippingMethodSchema,
    StorePaymentMethodSchema,
    StorePaymentMethodListSchema,
    StoreSelectedPaymentSchema,
    SelectPaymentMethodSchema,
    StoreOrderSchema,
  ]) {
    app.addSchema(schema);
  }

  app.decorateRequest('channel', null);

  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.config.public) return;
    const key = request.headers[PUBLISHABLE_KEY_HEADER];
    const channel = typeof key === 'string' ? await opts.channels.getByPublishableKey(key) : undefined;
    if (!channel) {
      return reply
        .code(401)
        .send(errorBody('invalid_publishable_key', `A valid ${PUBLISHABLE_KEY_HEADER} header is required`));
    }
    request.channel = channel;
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
    '/channel',
    {
      schema: {
        operationId: 'getCurrentChannel',
        summary: 'The channel selected by the publishable key',
        tags: ['channel'],
        response: { 200: StoreChannelSchema, 401: ErrorSchema },
      },
    },
    async (request) => toStoreChannel(request.channel!),
  );

  app.get(
    '/products',
    {
      schema: {
        operationId: 'listProducts',
        summary: 'Published products listed in the channel, newest first',
        tags: ['catalog'],
        querystring: ListStoreProductsQuerySchema,
        response: { 200: StoreProductPageSchema, 400: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (request, reply) => {
      const { category: handle, limit = DEFAULT_PAGE_SIZE, after } = request.query;
      const currency = request.query.currency ?? request.channel!.defaultCurrency;
      if (!request.channel!.currencies.includes(currency)) return reply.code(400).send(unsupportedCurrency(currency));
      let categoryId: string | undefined;
      if (handle !== undefined) {
        const category = await opts.catalog.getCategoryByHandle(handle);
        if (!category) return { data: [], nextCursor: null };
        categoryId = category.id;
      }
      const result = await opts.catalog.listProducts({
        ...storeFilter(request.channel!),
        ...(categoryId !== undefined && { categoryId }),
        ...(after !== undefined && { after }),
        limit,
      });
      if (!result.ok) return reply.code(400).send(errorBody(result.error.code, result.error.message));
      const page = result.value;
      const prices = await resolvePrices(page.items, request.channel!, currency);
      return { data: page.items.map((p) => toStoreProduct(p, prices)), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/products/:handle',
    {
      schema: {
        operationId: 'getProduct',
        tags: ['catalog'],
        params: Type.Object({ handle: Type.String() }),
        querystring: GetStoreProductQuerySchema,
        response: { 200: StoreProductSchema, 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const { handle } = request.params;
      const currency = request.query.currency ?? request.channel!.defaultCurrency;
      if (!request.channel!.currencies.includes(currency)) return reply.code(400).send(unsupportedCurrency(currency));
      const product = await opts.catalog.getProductByHandle(handle, storeFilter(request.channel!));
      if (!product) return reply.code(404).send(errorBody('product_not_found', `Product "${handle}" not found`));
      return toStoreProduct(product, await resolvePrices([product], request.channel!, currency));
    },
  );

  app.get(
    '/categories',
    {
      schema: {
        operationId: 'listCategories',
        tags: ['catalog'],
        response: { 200: StoreCategoryListSchema, 401: ErrorSchema },
      },
    },
    async () => ({ data: (await opts.catalog.listCategories()).map(toStoreCategory) }),
  );

  await app.register(cartRoutes, { carts: opts.carts });
  await app.register(orderRoutes, {
    checkout: opts.checkout,
    orders: opts.orders,
    cartChannel: async (cartId) => (await opts.carts.getCart(cartId))?.channelId,
  });

  /**
   * Prices come from the pricing module, resolved for the page in one call (ADR 0014). This is
   * composition at the API layer, not a join: neither module reads the other's tables.
   */
  function resolvePrices(products: readonly Product[], channel: Channel, currency: string) {
    const variantIds = products.flatMap((p) => p.variants.map((v) => v.id));
    return opts.pricing.resolvePrices(variantIds, { currency, channelId: channel.id, quantity: 1, at: new Date() });
  }
};

const unsupportedCurrency = (currency: string) =>
  errorBody('unsupported_currency', `This channel does not sell in ${currency}`);

/** The storefront sees only published products listed in its own channel (ADR 0004). */
const storeFilter = (channel: Channel) => ({ status: 'published', channelId: channel.id }) as const;

export {
  ErrorSchema,
  StoreChannelSchema,
  StoreProductSchema,
  type ErrorBody,
  type StoreCategory,
  type StoreChannel,
  type StoreProduct,
} from './schemas.js';
