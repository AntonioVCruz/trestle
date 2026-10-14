import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type {
  CatalogService,
  ChannelService,
  PriceInput,
  PricingService,
  UpdatePriceListError,
  UpdatePriceListInput,
} from '@trestle/core';
import {
  CreatePriceListSchema,
  errorBody,
  ErrorSchema,
  SetPriceListPricesSchema,
  SetVariantPricesSchema,
  toPriceDto,
  toPriceListDto,
  UpdatePriceListSchema,
  type ErrorBody,
} from './schemas.js';

export interface PricingRoutesOptions {
  readonly pricing: PricingService;
  readonly catalog: Pick<CatalogService, 'getVariants'>;
  readonly channels: Pick<ChannelService, 'getById'>;
}

const UPDATE_PRICE_LIST_STATUS: Record<UpdatePriceListError['code'], 400 | 404> = {
  invalid_input: 400,
  price_list_not_found: 404,
};

const IdParams = Type.Object({ id: Type.String() });

// Responses refer to shared schemas by id; see the note in catalog.ts.
const PriceCollection = Type.Ref('PriceCollection');
const PriceList = Type.Ref('PriceList');

const toDate = (value: string | null | undefined) => (value == null ? value : new Date(value));

export const pricingRoutes: FastifyPluginAsyncTypebox<PricingRoutesOptions> = async (app, { pricing, catalog, channels }) => {
  /**
   * Variants and channels belong to other modules, so they are checked through their services
   * (ADR 0002). A channel-scoped price must use one of that channel's currencies.
   */
  async function checkReferences(prices: readonly (PriceInput & { variantId?: string })[]): Promise<ErrorBody | undefined> {
    const variantIds = [...new Set(prices.flatMap((p) => (p.variantId ? [p.variantId] : [])))];
    if (variantIds.length > 0) {
      const found = new Set((await catalog.getVariants(variantIds)).map((v) => v.id));
      const missing = variantIds.find((id) => !found.has(id));
      if (missing) return errorBody('variant_not_found', `Variant "${missing}" not found`);
    }
    for (const channelId of new Set(prices.flatMap((p) => (p.channelId ? [p.channelId] : [])))) {
      const channel = await channels.getById(channelId);
      if (!channel) return errorBody('channel_not_found', `Channel "${channelId}" not found`);
      const foreign = prices.find((p) => p.channelId === channelId && !channel.currencies.includes(p.currency));
      if (foreign) {
        return errorBody('currency_not_in_channel', `Channel "${channel.code}" does not sell in ${foreign.currency}`);
      }
    }
    return undefined;
  }

  const variantExists = async (id: string) => (await catalog.getVariants([id])).length > 0;
  const variantNotFound = (id: string) => errorBody('variant_not_found', `Variant "${id}" not found`);

  app.get(
    '/variants/:id/prices',
    {
      schema: {
        operationId: 'listVariantPrices',
        summary: 'Base prices and price-list prices of a variant',
        tags: ['pricing'],
        params: IdParams,
        response: { 200: PriceCollection, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      if (!(await variantExists(request.params.id))) return reply.code(404).send(variantNotFound(request.params.id));
      return { data: (await pricing.listVariantPrices(request.params.id)).map(toPriceDto) };
    },
  );

  app.put(
    '/variants/:id/prices',
    {
      schema: {
        operationId: 'setVariantPrices',
        summary: "Replace a variant's base prices",
        tags: ['pricing'],
        params: IdParams,
        body: SetVariantPricesSchema,
        response: { 200: PriceCollection, 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await variantExists(id))) return reply.code(404).send(variantNotFound(id));
      const invalid = await checkReferences(request.body.prices);
      if (invalid) return reply.code(400).send(invalid);

      const result = await pricing.setVariantPrices(id, request.body.prices);
      if (!result.ok) return reply.code(400).send(errorBody(result.error.code, result.error.message));
      return { data: result.value.map(toPriceDto) };
    },
  );

  app.get(
    '/price-lists',
    {
      schema: {
        operationId: 'listPriceLists',
        tags: ['pricing'],
        response: { 200: Type.Ref('PriceListList'), 401: ErrorSchema },
      },
    },
    async () => ({ data: (await pricing.listPriceLists()).map(toPriceListDto) }),
  );

  app.post(
    '/price-lists',
    {
      schema: {
        operationId: 'createPriceList',
        tags: ['pricing'],
        body: CreatePriceListSchema,
        response: { 201: PriceList, 400: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (request, reply) => {
      const { startsAt, endsAt, ...rest } = request.body;
      const result = await pricing.createPriceList({ ...rest, startsAt: toDate(startsAt), endsAt: toDate(endsAt) });
      if (!result.ok) return reply.code(400).send(errorBody(result.error.code, result.error.message));
      return reply.code(201).send(toPriceListDto(result.value));
    },
  );

  app.get(
    '/price-lists/:id',
    {
      schema: {
        operationId: 'getPriceList',
        tags: ['pricing'],
        params: IdParams,
        response: { 200: PriceList, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const list = await pricing.getPriceList(request.params.id);
      if (!list) {
        return reply.code(404).send(errorBody('price_list_not_found', `Price list "${request.params.id}" not found`));
      }
      return toPriceListDto(list);
    },
  );

  app.patch(
    '/price-lists/:id',
    {
      schema: {
        operationId: 'updatePriceList',
        tags: ['pricing'],
        params: IdParams,
        body: UpdatePriceListSchema,
        response: { 200: PriceList, 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const { startsAt, endsAt, ...rest } = request.body;
      const input: UpdatePriceListInput = {
        ...rest,
        ...(startsAt !== undefined && { startsAt: toDate(startsAt) }),
        ...(endsAt !== undefined && { endsAt: toDate(endsAt) }),
      };
      const result = await pricing.updatePriceList(request.params.id, input);
      if (!result.ok) {
        return reply
          .code(UPDATE_PRICE_LIST_STATUS[result.error.code])
          .send(errorBody(result.error.code, result.error.message));
      }
      return toPriceListDto(result.value);
    },
  );

  app.get(
    '/price-lists/:id/prices',
    {
      schema: {
        operationId: 'listPriceListPrices',
        tags: ['pricing'],
        params: IdParams,
        response: { 200: PriceCollection, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      if (!(await pricing.getPriceList(request.params.id))) {
        return reply.code(404).send(errorBody('price_list_not_found', `Price list "${request.params.id}" not found`));
      }
      return { data: (await pricing.listPriceListPrices(request.params.id)).map(toPriceDto) };
    },
  );

  app.put(
    '/price-lists/:id/prices',
    {
      schema: {
        operationId: 'setPriceListPrices',
        summary: "Replace every price in a price list",
        tags: ['pricing'],
        params: IdParams,
        body: SetPriceListPricesSchema,
        response: { 200: PriceCollection, 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const invalid = await checkReferences(request.body.prices);
      if (invalid) return reply.code(400).send(invalid);
      const result = await pricing.setPriceListPrices(request.params.id, request.body.prices);
      if (!result.ok) {
        return reply
          .code(result.error.code === 'price_list_not_found' ? 404 : 400)
          .send(errorBody(result.error.code, result.error.message));
      }
      return { data: result.value.map(toPriceDto) };
    },
  );
};
