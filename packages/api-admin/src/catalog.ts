import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type {
  AddVariantError,
  CatalogService,
  ChannelService,
  CreateCategoryError,
  CreateProductError,
  SetProductCategoriesError,
  UpdateProductError,
} from '@trestle/core';
import {
  CategoryListSchema,
  CategorySchema,
  CreateCategorySchema,
  CreateProductSchema,
  CreateVariantSchema,
  DEFAULT_PAGE_SIZE,
  errorBody,
  ErrorSchema,
  ListProductsQuerySchema,
  ProductPageSchema,
  ProductSchema,
  SetProductCategoriesSchema,
  SetProductChannelsSchema,
  toCategoryDto,
  toProductDto,
  toVariantDto,
  UpdateProductSchema,
} from './schemas.js';

export interface CatalogRoutesOptions {
  readonly catalog: CatalogService;
  readonly channels: Pick<ChannelService, 'getById'>;
}

// Missing ids in a path are 404. Unknown ids inside a body (a parent category, a category to
// assign) are 400: the resource being addressed exists, the request is wrong.
const CREATE_PRODUCT_STATUS: Record<CreateProductError['code'], 400 | 409> = {
  invalid_input: 400,
  product_handle_taken: 409,
  sku_taken: 409,
};
const UPDATE_PRODUCT_STATUS: Record<UpdateProductError['code'], 400 | 404 | 409> = {
  invalid_input: 400,
  product_not_found: 404,
  product_handle_taken: 409,
  invalid_status_transition: 409,
};
const ADD_VARIANT_STATUS: Record<AddVariantError['code'], 400 | 404 | 409> = {
  invalid_input: 400,
  product_not_found: 404,
  sku_taken: 409,
};
const SET_CATEGORIES_STATUS: Record<SetProductCategoriesError['code'], 400 | 404> = {
  category_not_found: 400,
  product_not_found: 404,
};
const CREATE_CATEGORY_STATUS: Record<CreateCategoryError['code'], 400 | 409> = {
  invalid_input: 400,
  category_not_found: 400,
  category_handle_taken: 409,
};

const ProductParams = Type.Object({ id: Type.String() });

export const catalogRoutes: FastifyPluginAsyncTypebox<CatalogRoutesOptions> = async (app, { catalog, channels }) => {
  app.get(
    '/products',
    {
      schema: {
        operationId: 'listProducts',
        tags: ['catalog'],
        querystring: ListProductsQuerySchema,
        response: { 200: ProductPageSchema, 400: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (request, reply) => {
      const { limit = DEFAULT_PAGE_SIZE, ...filter } = request.query;
      const result = await catalog.listProducts({ ...filter, limit });
      if (!result.ok) return reply.code(400).send(errorBody(result.error.code, result.error.message));
      return { data: result.value.items.map(toProductDto), nextCursor: result.value.nextCursor };
    },
  );

  app.post(
    '/products',
    {
      schema: {
        operationId: 'createProduct',
        tags: ['catalog'],
        body: CreateProductSchema,
        response: { 201: ProductSchema, 400: ErrorSchema, 401: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (request, reply) => {
      const result = await catalog.createProduct(request.body);
      if (!result.ok) {
        return reply.code(CREATE_PRODUCT_STATUS[result.error.code]).send(errorBody(result.error.code, result.error.message));
      }
      return reply.code(201).send(toProductDto(result.value));
    },
  );

  app.get(
    '/products/:id',
    {
      schema: {
        operationId: 'getProduct',
        tags: ['catalog'],
        params: ProductParams,
        response: { 200: ProductSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const product = await catalog.getProduct(request.params.id);
      if (!product) {
        return reply.code(404).send(errorBody('product_not_found', `Product "${request.params.id}" not found`));
      }
      return toProductDto(product);
    },
  );

  app.patch(
    '/products/:id',
    {
      schema: {
        operationId: 'updateProduct',
        tags: ['catalog'],
        params: ProductParams,
        body: UpdateProductSchema,
        response: { 200: ProductSchema, 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (request, reply) => {
      const result = await catalog.updateProduct(request.params.id, request.body);
      if (!result.ok) {
        return reply.code(UPDATE_PRODUCT_STATUS[result.error.code]).send(errorBody(result.error.code, result.error.message));
      }
      return toProductDto(result.value);
    },
  );

  app.post(
    '/products/:id/variants',
    {
      schema: {
        operationId: 'createVariant',
        tags: ['catalog'],
        params: ProductParams,
        body: CreateVariantSchema,
        // By reference: using the shared `Variant` object directly in this child plugin breaks
        // Fastify's resolution of the `Variant` ref inside `Product`.
        response: { 201: Type.Ref('Variant'), 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (request, reply) => {
      const result = await catalog.addVariant(request.params.id, request.body);
      if (!result.ok) {
        return reply.code(ADD_VARIANT_STATUS[result.error.code]).send(errorBody(result.error.code, result.error.message));
      }
      return reply.code(201).send(toVariantDto(result.value));
    },
  );

  app.put(
    '/products/:id/channels',
    {
      schema: {
        operationId: 'setProductChannels',
        summary: 'Replace the channels a product is listed in',
        tags: ['catalog'],
        params: ProductParams,
        body: SetProductChannelsSchema,
        response: { 200: ProductSchema, 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      // Channels belong to another module, so they are checked through its service (ADR 0002).
      for (const channelId of request.body.channelIds) {
        if (!(await channels.getById(channelId))) {
          return reply.code(400).send(errorBody('channel_not_found', `Channel "${channelId}" not found`));
        }
      }
      const result = await catalog.setProductChannels(request.params.id, request.body.channelIds);
      if (!result.ok) return reply.code(404).send(errorBody(result.error.code, result.error.message));
      return toProductDto(result.value);
    },
  );

  app.put(
    '/products/:id/categories',
    {
      schema: {
        operationId: 'setProductCategories',
        summary: 'Replace the categories a product belongs to',
        tags: ['catalog'],
        params: ProductParams,
        body: SetProductCategoriesSchema,
        response: { 200: ProductSchema, 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const result = await catalog.setProductCategories(request.params.id, request.body.categoryIds);
      if (!result.ok) {
        return reply.code(SET_CATEGORIES_STATUS[result.error.code]).send(errorBody(result.error.code, result.error.message));
      }
      return toProductDto(result.value);
    },
  );

  app.get(
    '/categories',
    {
      schema: {
        operationId: 'listCategories',
        tags: ['catalog'],
        response: { 200: CategoryListSchema, 401: ErrorSchema },
      },
    },
    async () => ({ data: (await catalog.listCategories()).map(toCategoryDto) }),
  );

  app.post(
    '/categories',
    {
      schema: {
        operationId: 'createCategory',
        tags: ['catalog'],
        body: CreateCategorySchema,
        response: { 201: CategorySchema, 400: ErrorSchema, 401: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (request, reply) => {
      const result = await catalog.createCategory(request.body);
      if (!result.ok) {
        return reply.code(CREATE_CATEGORY_STATUS[result.error.code]).send(errorBody(result.error.code, result.error.message));
      }
      return reply.code(201).send(toCategoryDto(result.value));
    },
  );
};
