import { sql, type Kysely, type Selectable } from 'kysely';
import { isUniqueViolation, type CoreDatabase } from '../../kernel/db.js';
import { isId, newId } from '../../kernel/id.js';
import { recordEvent, type OutboxTables } from '../../kernel/outbox.js';
import { err, ok, type DomainError, type Result } from '../../kernel/result.js';
import {
  isHandle,
  planVariant,
  planVariants,
  productStatusMachine,
  type PlannedVariant,
  type ProductOption,
  type ProductStatus,
  type VariantInput,
  type VariantOptionValue,
} from './rules.js';
import type { CatalogTables, CategoryTable, ProductTable, ProductVariantTable } from './tables.js';

/**
 * Products, their options and variants, categories, and which channels each product is listed
 * in (ADR 0007, ADR 0013). A variant is the sellable unit that pricing, inventory and carts
 * refer to by id.
 */
export interface Product {
  readonly id: string;
  readonly handle: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: ProductStatus;
  readonly options: readonly ProductOption[];
  readonly variants: readonly Variant[];
  readonly categoryIds: readonly string[];
  readonly channelIds: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Variant {
  readonly id: string;
  readonly productId: string;
  readonly sku: string | null;
  readonly title: string;
  /** One value per product option, in option order. */
  readonly options: readonly VariantOptionValue[];
  readonly position: number;
}

export interface Category {
  readonly id: string;
  readonly parentId: string | null;
  readonly handle: string;
  readonly name: string;
  readonly position: number;
  readonly createdAt: Date;
}

export interface CreateProductInput {
  readonly handle: string;
  readonly title: string;
  readonly description?: string | null;
  readonly status?: ProductStatus;
  readonly options?: readonly ProductOption[];
  /** Omit for a product without options to get a single default variant. */
  readonly variants?: readonly VariantInput[];
}

export interface UpdateProductInput {
  readonly handle?: string;
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: ProductStatus;
}

export interface CreateCategoryInput {
  readonly handle: string;
  readonly name: string;
  readonly parentId?: string | null;
  readonly position?: number;
}

/** Narrows products for a reader. The Store API always passes `published` and its channel. */
export interface ProductFilter {
  readonly status?: ProductStatus;
  readonly channelId?: string;
  readonly categoryId?: string;
}

export interface ListProductsQuery extends ProductFilter {
  /** 1 to 100. */
  readonly limit: number;
  /** Cursor from a previous page's `nextCursor`. */
  readonly after?: string;
}

/** Newest first. `nextCursor` is null on the last page. */
export interface ProductPage {
  readonly items: Product[];
  readonly nextCursor: string | null;
}

/** `after` is not a cursor this service handed out. */
export type ListProductsError = DomainError<'invalid_cursor'>;
export type CreateProductError = DomainError<'invalid_input' | 'product_handle_taken' | 'sku_taken'>;
export type UpdateProductError = DomainError<
  'invalid_input' | 'product_not_found' | 'product_handle_taken' | 'invalid_status_transition'
>;
export type AddVariantError = DomainError<'invalid_input' | 'product_not_found' | 'sku_taken'>;
export type SetProductChannelsError = DomainError<'product_not_found'>;
export type SetProductCategoriesError = DomainError<'product_not_found' | 'category_not_found'>;
export type CreateCategoryError = DomainError<'invalid_input' | 'category_handle_taken' | 'category_not_found'>;

export interface CatalogService {
  createProduct(input: CreateProductInput): Promise<Result<Product, CreateProductError>>;
  getProduct(id: string): Promise<Product | undefined>;
  /** Products by id, in no particular order; unknown ids are skipped. */
  getProducts(ids: readonly string[]): Promise<Product[]>;
  getProductByHandle(handle: string, filter?: ProductFilter): Promise<Product | undefined>;
  listProducts(query: ListProductsQuery): Promise<Result<ProductPage, ListProductsError>>;
  updateProduct(id: string, input: UpdateProductInput): Promise<Result<Product, UpdateProductError>>;
  addVariant(productId: string, input: VariantInput): Promise<Result<Variant, AddVariantError>>;
  /** Variants by id, in no particular order; unknown ids are skipped. */
  getVariants(ids: readonly string[]): Promise<Variant[]>;
  /**
   * Replaces the channels a product is listed in. Channel ids are not checked here: they belong
   * to the channel module, so callers validate them through the channel service.
   */
  setProductChannels(productId: string, channelIds: readonly string[]): Promise<Result<Product, SetProductChannelsError>>;
  setProductCategories(
    productId: string,
    categoryIds: readonly string[],
  ): Promise<Result<Product, SetProductCategoriesError>>;
  createCategory(input: CreateCategoryInput): Promise<Result<Category, CreateCategoryError>>;
  listCategories(): Promise<Category[]>;
  getCategoryByHandle(handle: string): Promise<Category | undefined>;
}

export const PRODUCT_CREATED = 'product.created';
export const PRODUCT_UPDATED = 'product.updated';
/** Recorded for every variant, including those created with their product. */
export const VARIANT_CREATED = 'variant.created';
export const CATEGORY_CREATED = 'category.created';

export const MAX_PAGE_SIZE = 100;

type Db = Kysely<CatalogTables & OutboxTables>;
type ProductRow = Selectable<ProductTable>;

export function createCatalogService(database: CoreDatabase): CatalogService {
  const db: Db = database.withTables<CatalogTables & OutboxTables>();

  /** Products matching a filter; callers add ordering and paging. */
  const products = (filter: ProductFilter) =>
    db
      .selectFrom('product')
      .selectAll('product')
      .$if(filter.status !== undefined, (q) => q.where('product.status', '=', filter.status!))
      .$if(filter.channelId !== undefined, (q) =>
        q.where(({ exists, selectFrom }) =>
          exists(
            selectFrom('product_channel')
              .select('product_channel.product_id')
              .whereRef('product_channel.product_id', '=', 'product.id')
              .where('product_channel.channel_id', '=', filter.channelId!),
          ),
        ),
      )
      .$if(filter.categoryId !== undefined, (q) =>
        q.where(({ exists, selectFrom }) =>
          exists(
            selectFrom('product_category')
              .select('product_category.product_id')
              .whereRef('product_category.product_id', '=', 'product.id')
              .where('product_category.category_id', '=', filter.categoryId!),
          ),
        ),
      );

  const getProduct = async (id: string) => {
    const row = await db.selectFrom('product').selectAll().where('id', '=', id).executeTakeFirst();
    return row && (await loadProducts(db, [row]))[0];
  };

  return {
    async createProduct(input) {
      if (!isHandle(input.handle)) return err('invalid_input', `Invalid handle "${input.handle}"`);
      if (!input.title.trim()) return err('invalid_input', 'Title must not be empty');
      const status = input.status ?? productStatusMachine.initial;
      if (status !== productStatusMachine.initial && !productStatusMachine.can(productStatusMachine.initial, status)) {
        return err('invalid_input', `A new product cannot start as "${status}"`);
      }
      const options = input.options ?? [];
      const planned = planVariants(options, input.variants ?? []);
      if (!planned.ok) return planned;

      try {
        const product = await db.transaction().execute(async (trx) => {
          const row = await trx
            .insertInto('product')
            .values({
              id: newId('prod'),
              handle: input.handle,
              title: input.title,
              description: input.description ?? null,
              status,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          const valueIds = await insertOptions(trx, row.id, options);
          const variants = await insertVariants(trx, row.id, planned.value, 0, valueIds);
          await recordEvent(trx, PRODUCT_CREATED, { id: row.id, handle: row.handle });
          for (const variant of variants) await recordVariantCreated(trx, variant);
          return (await loadProducts(trx, [row]))[0]!;
        });
        return ok(product);
      } catch (error) {
        if (isUniqueViolation(error, 'product_handle_key')) {
          return err('product_handle_taken', `A product with handle "${input.handle}" already exists`);
        }
        if (isUniqueViolation(error, 'product_variant_sku_key')) return err('sku_taken', 'A variant SKU is already in use');
        throw error;
      }
    },

    getProduct,

    async getProducts(ids) {
      if (ids.length === 0) return [];
      const rows = await db.selectFrom('product').selectAll().where('id', 'in', ids).execute();
      return loadProducts(db, rows);
    },

    async getProductByHandle(handle, filter = {}) {
      const row = await products(filter).where('product.handle', '=', handle).executeTakeFirst();
      return row && (await loadProducts(db, [row]))[0];
    },

    async listProducts({ limit, after, ...filter }) {
      // The cursor is the last product's id; anything else would silently restart the listing.
      if (after !== undefined && !isId(after, 'prod')) return err('invalid_cursor', 'Pass back the nextCursor of a previous page as after');
      const size = Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
      const rows = await products(filter)
        .$if(after !== undefined, (q) => q.where('product.id', '<', after!))
        .orderBy('product.id', 'desc')
        .limit(size + 1)
        .execute();
      const page = rows.slice(0, size);
      return ok({
        items: await loadProducts(db, page),
        nextCursor: rows.length > size ? page.at(-1)!.id : null,
      });
    },

    async updateProduct(id, input) {
      if (input.handle !== undefined && !isHandle(input.handle)) {
        return err('invalid_input', `Invalid handle "${input.handle}"`);
      }
      if (input.title !== undefined && !input.title.trim()) return err('invalid_input', 'Title must not be empty');

      try {
        return await db.transaction().execute(async (trx): Promise<Result<Product, UpdateProductError>> => {
          const current = await lockProduct(trx, id);
          if (!current) return err('product_not_found', `Product "${id}" not found`);
          if (input.status !== undefined && input.status !== current.status) {
            if (!productStatusMachine.can(current.status, input.status)) {
              return err('invalid_status_transition', `Cannot change status from "${current.status}" to "${input.status}"`);
            }
          }

          const row = await trx
            .updateTable('product')
            .set({
              ...(input.handle !== undefined && { handle: input.handle }),
              ...(input.title !== undefined && { title: input.title }),
              ...(input.description !== undefined && { description: input.description }),
              ...(input.status !== undefined && { status: input.status }),
              updated_at: sql<Date>`now()`,
            })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordProductUpdated(trx, row);
          return ok((await loadProducts(trx, [row]))[0]!);
        });
      } catch (error) {
        if (isUniqueViolation(error, 'product_handle_key')) {
          return err('product_handle_taken', `A product with handle "${input.handle}" already exists`);
        }
        throw error;
      }
    },

    async addVariant(productId, input) {
      try {
        return await db.transaction().execute(async (trx): Promise<Result<Variant, AddVariantError>> => {
          // The row lock serializes concurrent additions, so the combination check below holds.
          const row = await lockProduct(trx, productId);
          if (!row) return err('product_not_found', `Product "${productId}" not found`);
          const product = (await loadProducts(trx, [row]))[0]!;

          const planned = planVariant(product.options, product.variants, input);
          if (!planned.ok) return planned;

          const position = (product.variants.at(-1)?.position ?? -1) + 1;
          const [variant] = await insertVariants(trx, productId, [planned.value], position, await optionValueIds(trx, productId));
          await touchProduct(trx, productId);
          await recordVariantCreated(trx, variant!);
          return ok(variant!);
        });
      } catch (error) {
        if (isUniqueViolation(error, 'product_variant_sku_key')) {
          return err('sku_taken', `SKU "${input.sku}" is already in use`);
        }
        throw error;
      }
    },

    async getVariants(ids) {
      if (ids.length === 0) return [];
      const [rows, values] = await Promise.all([
        db.selectFrom('product_variant').selectAll().where('id', 'in', ids).execute(),
        db
          .selectFrom('product_variant_option_value as vov')
          .innerJoin('product_option_value as v', 'v.id', 'vov.option_value_id')
          .innerJoin('product_option as o', 'o.id', 'v.option_id')
          .select(['vov.variant_id', 'o.name', 'v.value'])
          .where('vov.variant_id', 'in', ids)
          .orderBy('o.position')
          .execute(),
      ]);
      const valuesByVariant = group(values, (row) => row.variant_id);
      return rows.map((v) => toVariant(v, valuesByVariant.get(v.id) ?? []));
    },

    async setProductChannels(productId, channelIds) {
      return db.transaction().execute(async (trx): Promise<Result<Product, SetProductChannelsError>> => {
        if (!(await lockProduct(trx, productId))) return err('product_not_found', `Product "${productId}" not found`);
        await trx.deleteFrom('product_channel').where('product_id', '=', productId).execute();
        const unique = [...new Set(channelIds)];
        if (unique.length > 0) {
          await trx
            .insertInto('product_channel')
            .values(unique.map((channelId) => ({ product_id: productId, channel_id: channelId })))
            .execute();
        }
        const row = await touchProduct(trx, productId);
        await recordProductUpdated(trx, row);
        return ok((await loadProducts(trx, [row]))[0]!);
      });
    },

    async setProductCategories(productId, categoryIds) {
      return db.transaction().execute(async (trx): Promise<Result<Product, SetProductCategoriesError>> => {
        if (!(await lockProduct(trx, productId))) return err('product_not_found', `Product "${productId}" not found`);
        const unique = [...new Set(categoryIds)];
        if (unique.length > 0) {
          const found = await trx.selectFrom('category').select('id').where('id', 'in', unique).execute();
          const missing = unique.find((id) => !found.some((c) => c.id === id));
          if (missing) return err('category_not_found', `Category "${missing}" not found`);
        }
        await trx.deleteFrom('product_category').where('product_id', '=', productId).execute();
        if (unique.length > 0) {
          await trx
            .insertInto('product_category')
            .values(unique.map((categoryId) => ({ product_id: productId, category_id: categoryId })))
            .execute();
        }
        const row = await touchProduct(trx, productId);
        await recordProductUpdated(trx, row);
        return ok((await loadProducts(trx, [row]))[0]!);
      });
    },

    async createCategory(input) {
      if (!isHandle(input.handle)) return err('invalid_input', `Invalid handle "${input.handle}"`);
      if (!input.name.trim()) return err('invalid_input', 'Name must not be empty');
      const parentId = input.parentId ?? null;

      try {
        return await db.transaction().execute(async (trx): Promise<Result<Category, CreateCategoryError>> => {
          if (parentId && !(await trx.selectFrom('category').select('id').where('id', '=', parentId).executeTakeFirst())) {
            return err('category_not_found', `Parent category "${parentId}" not found`);
          }
          const row = await trx
            .insertInto('category')
            .values({
              id: newId('cat'),
              parent_id: parentId,
              handle: input.handle,
              name: input.name,
              position: input.position ?? 0,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordEvent(trx, CATEGORY_CREATED, { id: row.id, handle: row.handle });
          return ok(toCategory(row));
        });
      } catch (error) {
        if (isUniqueViolation(error, 'category_handle_key')) {
          return err('category_handle_taken', `A category with handle "${input.handle}" already exists`);
        }
        throw error;
      }
    },

    async listCategories() {
      const rows = await db.selectFrom('category').selectAll().orderBy('position').orderBy('name').orderBy('id').execute();
      return rows.map(toCategory);
    },

    async getCategoryByHandle(handle) {
      const row = await db.selectFrom('category').selectAll().where('handle', '=', handle).executeTakeFirst();
      return row && toCategory(row);
    },
  };
}

function lockProduct(trx: Db, id: string): Promise<ProductRow | undefined> {
  return trx.selectFrom('product').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
}

function touchProduct(trx: Db, id: string): Promise<ProductRow> {
  return trx
    .updateTable('product')
    .set({ updated_at: sql<Date>`now()` })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

function recordProductUpdated(trx: Db, row: ProductRow): Promise<void> {
  return recordEvent(trx, PRODUCT_UPDATED, { id: row.id, handle: row.handle, status: row.status });
}

function recordVariantCreated(trx: Db, variant: Variant): Promise<void> {
  return recordEvent(trx, VARIANT_CREATED, { id: variant.id, productId: variant.productId, sku: variant.sku });
}

const valueKey = (name: string, value: string) => JSON.stringify([name, value]);

/** Inserts options and their values; returns value ids keyed by option name and value. */
async function insertOptions(trx: Db, productId: string, options: readonly ProductOption[]): Promise<Map<string, string>> {
  const valueIds = new Map<string, string>();
  if (options.length === 0) return valueIds;

  const optionRows = options.map((option, position) => ({ id: newId('opt'), product_id: productId, name: option.name, position }));
  const valueRows = options.flatMap((option, i) =>
    option.values.map((value, position) => {
      const id = newId('optval');
      valueIds.set(valueKey(option.name, value), id);
      return { id, option_id: optionRows[i]!.id, value, position };
    }),
  );
  await trx.insertInto('product_option').values(optionRows).execute();
  await trx.insertInto('product_option_value').values(valueRows).execute();
  return valueIds;
}

async function optionValueIds(trx: Db, productId: string): Promise<Map<string, string>> {
  const rows = await trx
    .selectFrom('product_option_value as v')
    .innerJoin('product_option as o', 'o.id', 'v.option_id')
    .select(['v.id', 'o.name', 'v.value'])
    .where('o.product_id', '=', productId)
    .execute();
  return new Map(rows.map((row) => [valueKey(row.name, row.value), row.id]));
}

async function insertVariants(
  trx: Db,
  productId: string,
  planned: readonly PlannedVariant[],
  firstPosition: number,
  valueIds: ReadonlyMap<string, string>,
): Promise<Variant[]> {
  const variants: Variant[] = planned.map((variant, i) => ({
    id: newId('var'),
    productId,
    sku: variant.sku,
    title: variant.title,
    options: variant.options,
    position: firstPosition + i,
  }));
  await trx
    .insertInto('product_variant')
    .values(variants.map((v) => ({ id: v.id, product_id: productId, sku: v.sku, title: v.title, position: v.position })))
    .execute();

  const links = variants.flatMap((v) =>
    v.options.map((o) => ({ variant_id: v.id, option_value_id: valueIds.get(valueKey(o.name, o.value))! })),
  );
  if (links.length > 0) await trx.insertInto('product_variant_option_value').values(links).execute();
  return variants;
}

/**
 * Assembles full products in a fixed number of queries, however many rows are passed
 * (ADR 0011 asserts this on the listing path).
 */
async function loadProducts(db: Db, rows: readonly ProductRow[]): Promise<Product[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [optionValues, variants, variantValues, categories, channels] = await Promise.all([
    db
      .selectFrom('product_option as o')
      .innerJoin('product_option_value as v', 'v.option_id', 'o.id')
      .select(['o.product_id', 'o.name', 'v.value'])
      .where('o.product_id', 'in', ids)
      .orderBy('o.position')
      .orderBy('v.position')
      .execute(),
    db.selectFrom('product_variant').selectAll().where('product_id', 'in', ids).orderBy('position').execute(),
    db
      .selectFrom('product_variant_option_value as vov')
      .innerJoin('product_option_value as v', 'v.id', 'vov.option_value_id')
      .innerJoin('product_option as o', 'o.id', 'v.option_id')
      .select(['vov.variant_id', 'o.name', 'v.value'])
      .where('o.product_id', 'in', ids)
      .orderBy('o.position')
      .execute(),
    db.selectFrom('product_category').selectAll().where('product_id', 'in', ids).orderBy('category_id').execute(),
    db.selectFrom('product_channel').selectAll().where('product_id', 'in', ids).orderBy('channel_id').execute(),
  ]);

  const optionsByProduct = new Map<string, { name: string; values: string[] }[]>();
  for (const row of optionValues) {
    const options = optionsByProduct.get(row.product_id) ?? [];
    let option = options.find((o) => o.name === row.name);
    if (!option) options.push((option = { name: row.name, values: [] }));
    option.values.push(row.value);
    optionsByProduct.set(row.product_id, options);
  }

  const valuesByVariant = group(variantValues, (row) => row.variant_id);

  return rows.map((row) => ({
    id: row.id,
    handle: row.handle,
    title: row.title,
    description: row.description,
    status: row.status,
    options: optionsByProduct.get(row.id) ?? [],
    variants: variants.filter((v) => v.product_id === row.id).map((v) => toVariant(v, valuesByVariant.get(v.id) ?? [])),
    categoryIds: categories.filter((c) => c.product_id === row.id).map((c) => c.category_id),
    channelIds: channels.filter((c) => c.product_id === row.id).map((c) => c.channel_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function group<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

function toVariant(row: Selectable<ProductVariantTable>, values: readonly VariantOptionValue[]): Variant {
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    title: row.title,
    options: values.map(({ name, value }) => ({ name, value })),
    position: row.position,
  };
}

function toCategory(row: Selectable<CategoryTable>): Category {
  return {
    id: row.id,
    parentId: row.parent_id,
    handle: row.handle,
    name: row.name,
    position: row.position,
    createdAt: row.created_at,
  };
}
