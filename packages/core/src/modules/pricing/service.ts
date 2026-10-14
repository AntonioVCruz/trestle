import { sql, type Kysely, type Selectable } from 'kysely';
import type { CoreDatabase } from '../../kernel/db.js';
import { newId } from '../../kernel/id.js';
import { money, type Money } from '../../kernel/money.js';
import { recordEvent, type OutboxTables } from '../../kernel/outbox.js';
import { err, ok, type DomainError, type Result } from '../../kernel/result.js';
import {
  checkPriceListWindow,
  checkPrices,
  resolvePrice,
  type PriceCandidate,
  type PriceContext,
  type PriceInput,
  type PriceListStatus,
  type PriceListType,
  type ResolvedPrice,
} from './rules.js';
import type { PriceListTable, PricingTables } from './tables.js';

/**
 * Prices for variants (ADR 0007, ADR 0014). Each variant has a price set: base prices plus any
 * prices from price lists. `resolvePrices` decides which one applies in a given context.
 * Variant and channel ids are plain references to other modules; callers validate them.
 */
export interface Price {
  readonly id: string;
  readonly variantId: string;
  /** Null for a base price. */
  readonly priceListId: string | null;
  readonly amount: Money;
  readonly channelId: string | null;
  readonly minQuantity: number;
}

export interface PriceList {
  readonly id: string;
  readonly name: string;
  readonly type: PriceListType;
  readonly status: PriceListStatus;
  /** Between live lists of the same type, the higher priority wins. */
  readonly priority: number;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreatePriceListInput {
  readonly name: string;
  /** Defaults to `sale`. */
  readonly type?: PriceListType;
  readonly status?: PriceListStatus;
  readonly priority?: number;
  readonly startsAt?: Date | null;
  readonly endsAt?: Date | null;
}

export type UpdatePriceListInput = Partial<CreatePriceListInput>;

export interface PriceListPriceInput extends PriceInput {
  readonly variantId: string;
}

export type SetVariantPricesError = DomainError<'invalid_input'>;
export type CreatePriceListError = DomainError<'invalid_input'>;
export type UpdatePriceListError = DomainError<'invalid_input' | 'price_list_not_found'>;
export type SetPriceListPricesError = DomainError<'invalid_input' | 'price_list_not_found'>;

export interface PricingService {
  /** Base prices and list prices of one variant. */
  listVariantPrices(variantId: string): Promise<Price[]>;
  /** Replaces the variant's base prices; list prices are untouched. */
  setVariantPrices(variantId: string, prices: readonly PriceInput[]): Promise<Result<Price[], SetVariantPricesError>>;
  listPriceLists(): Promise<PriceList[]>;
  getPriceList(id: string): Promise<PriceList | undefined>;
  createPriceList(input: CreatePriceListInput): Promise<Result<PriceList, CreatePriceListError>>;
  updatePriceList(id: string, input: UpdatePriceListInput): Promise<Result<PriceList, UpdatePriceListError>>;
  listPriceListPrices(priceListId: string): Promise<Price[]>;
  /** Replaces every price in the list. */
  setPriceListPrices(
    priceListId: string,
    prices: readonly PriceListPriceInput[],
  ): Promise<Result<Price[], SetPriceListPricesError>>;
  /** The applicable price per variant, in one query. Variants without one are absent. */
  resolvePrices(variantIds: readonly string[], context: PriceContext): Promise<Map<string, ResolvedPrice>>;
}

export const VARIANT_PRICES_UPDATED = 'variant_prices.updated';
export const PRICE_LIST_CREATED = 'price_list.created';
/** Recorded when a list's settings or its prices change. */
export const PRICE_LIST_UPDATED = 'price_list.updated';

type Db = Kysely<PricingTables & OutboxTables>;

export function createPricingService(database: CoreDatabase): PricingService {
  const db: Db = database.withTables<PricingTables & OutboxTables>();

  const prices = (conn: Db) =>
    conn
      .selectFrom('price as p')
      .innerJoin('price_set as s', 's.id', 'p.price_set_id')
      .select(['p.id', 's.variant_id', 'p.price_list_id', 'p.currency', 'p.amount', 'p.channel_id', 'p.min_quantity'])
      .orderBy('p.currency')
      .orderBy('p.channel_id', (o) => o.nullsFirst())
      .orderBy('p.min_quantity');

  const getPriceList = async (id: string) => {
    const row = await db.selectFrom('price_list').selectAll().where('id', '=', id).executeTakeFirst();
    return row && toPriceList(row);
  };

  return {
    async listVariantPrices(variantId) {
      const rows = await prices(db).where('s.variant_id', '=', variantId).orderBy('p.price_list_id', (o) => o.nullsFirst()).execute();
      return rows.map(toPrice);
    },

    async setVariantPrices(variantId, input) {
      const checked = checkPrices(input);
      if (!checked.ok) return checked;

      const rows = await db.transaction().execute(async (trx) => {
        const setIds = await ensurePriceSets(trx, [variantId]);
        const priceSetId = setIds.get(variantId)!;
        await trx.deleteFrom('price').where('price_set_id', '=', priceSetId).where('price_list_id', 'is', null).execute();
        await insertPrices(trx, null, input.map((price) => ({ ...price, priceSetId })));
        await recordEvent(trx, VARIANT_PRICES_UPDATED, { variantId });
        return prices(trx).where('s.variant_id', '=', variantId).where('p.price_list_id', 'is', null).execute();
      });
      return ok(rows.map(toPrice));
    },

    async listPriceLists() {
      const rows = await db.selectFrom('price_list').selectAll().orderBy('priority', 'desc').orderBy('created_at').execute();
      return rows.map(toPriceList);
    },

    getPriceList,

    async createPriceList(input) {
      const checked = checkListInput(input);
      if (!checked.ok) return checked;
      const row = await db.transaction().execute(async (trx) => {
        const inserted = await trx
          .insertInto('price_list')
          .values({
            id: newId('plist'),
            name: input.name,
            type: input.type ?? 'sale',
            status: input.status ?? 'draft',
            priority: input.priority ?? 0,
            starts_at: input.startsAt ?? null,
            ends_at: input.endsAt ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await recordEvent(trx, PRICE_LIST_CREATED, { id: inserted.id });
        return inserted;
      });
      return ok(toPriceList(row));
    },

    async updatePriceList(id, input) {
      if (input.name !== undefined && !input.name.trim()) return err('invalid_input', 'Name must not be empty');
      if (input.priority !== undefined && !Number.isSafeInteger(input.priority)) {
        return err('invalid_input', 'Priority must be an integer');
      }
      return db.transaction().execute(async (trx): Promise<Result<PriceList, UpdatePriceListError>> => {
        const current = await trx.selectFrom('price_list').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!current) return err('price_list_not_found', `Price list "${id}" not found`);
        const window = checkPriceListWindow(
          input.startsAt !== undefined ? input.startsAt : current.starts_at,
          input.endsAt !== undefined ? input.endsAt : current.ends_at,
        );
        if (!window.ok) return window;

        const row = await trx
          .updateTable('price_list')
          .set({
            ...(input.name !== undefined && { name: input.name }),
            ...(input.type !== undefined && { type: input.type }),
            ...(input.status !== undefined && { status: input.status }),
            ...(input.priority !== undefined && { priority: input.priority }),
            ...(input.startsAt !== undefined && { starts_at: input.startsAt }),
            ...(input.endsAt !== undefined && { ends_at: input.endsAt }),
            updated_at: sql<Date>`now()`,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await recordEvent(trx, PRICE_LIST_UPDATED, { id });
        return ok(toPriceList(row));
      });
    },

    async listPriceListPrices(priceListId) {
      const rows = await prices(db).where('p.price_list_id', '=', priceListId).orderBy('s.variant_id').execute();
      return rows.map(toPrice);
    },

    async setPriceListPrices(priceListId, input) {
      const byVariant = new Map<string, PriceListPriceInput[]>();
      for (const price of input) byVariant.set(price.variantId, [...(byVariant.get(price.variantId) ?? []), price]);
      for (const [variantId, variantPrices] of byVariant) {
        const checked = checkPrices(variantPrices);
        if (!checked.ok) return err('invalid_input', `Variant "${variantId}": ${checked.error.message}`);
      }

      return db.transaction().execute(async (trx): Promise<Result<Price[], SetPriceListPricesError>> => {
        const list = await trx.selectFrom('price_list').select('id').where('id', '=', priceListId).forUpdate().executeTakeFirst();
        if (!list) return err('price_list_not_found', `Price list "${priceListId}" not found`);

        await trx.deleteFrom('price').where('price_list_id', '=', priceListId).execute();
        const setIds = await ensurePriceSets(trx, [...byVariant.keys()]);
        await insertPrices(trx, priceListId, input.map((price) => ({ ...price, priceSetId: setIds.get(price.variantId)! })));
        await recordEvent(trx, PRICE_LIST_UPDATED, { id: priceListId });
        const rows = await prices(trx).where('p.price_list_id', '=', priceListId).orderBy('s.variant_id').execute();
        return ok(rows.map(toPrice));
      });
    },

    async resolvePrices(variantIds, context) {
      const resolved = new Map<string, ResolvedPrice>();
      if (variantIds.length === 0) return resolved;

      const rows = await db
        .selectFrom('price as p')
        .innerJoin('price_set as s', 's.id', 'p.price_set_id')
        .leftJoin('price_list as l', 'l.id', 'p.price_list_id')
        .select([
          'p.id',
          's.variant_id',
          'p.currency',
          'p.amount',
          'p.channel_id',
          'p.min_quantity',
          'l.id as list_id',
          'l.type as list_type',
          'l.status as list_status',
          'l.priority as list_priority',
          'l.starts_at as list_starts_at',
          'l.ends_at as list_ends_at',
        ])
        .where('s.variant_id', 'in', [...new Set(variantIds)])
        .where('p.currency', '=', context.currency)
        .execute();

      const candidates = new Map<string, PriceCandidate[]>();
      for (const row of rows) {
        const candidate: PriceCandidate = {
          id: row.id,
          amount: money(Number(row.amount), row.currency),
          channelId: row.channel_id,
          minQuantity: row.min_quantity,
          list:
            row.list_id === null
              ? null
              : {
                  id: row.list_id,
                  type: row.list_type!,
                  status: row.list_status!,
                  priority: row.list_priority!,
                  startsAt: row.list_starts_at,
                  endsAt: row.list_ends_at,
                },
        };
        candidates.set(row.variant_id, [...(candidates.get(row.variant_id) ?? []), candidate]);
      }
      for (const [variantId, list] of candidates) {
        const price = resolvePrice(list, context);
        if (price) resolved.set(variantId, price);
      }
      return resolved;
    },
  };
}

function checkListInput(input: CreatePriceListInput): Result<void, DomainError<'invalid_input'>> {
  if (!input.name.trim()) return err('invalid_input', 'Name must not be empty');
  if (input.priority !== undefined && !Number.isSafeInteger(input.priority)) {
    return err('invalid_input', 'Priority must be an integer');
  }
  return checkPriceListWindow(input.startsAt ?? null, input.endsAt ?? null);
}

/**
 * Creates missing price sets and locks them, in variant order so concurrent writers cannot
 * deadlock; returns price set ids by variant id.
 */
async function ensurePriceSets(trx: Db, variantIds: readonly string[]): Promise<Map<string, string>> {
  if (variantIds.length === 0) return new Map();
  await trx
    .insertInto('price_set')
    .values(variantIds.map((variantId) => ({ id: newId('pset'), variant_id: variantId })))
    .onConflict((oc) => oc.column('variant_id').doNothing())
    .execute();
  const rows = await trx
    .selectFrom('price_set')
    .select(['id', 'variant_id'])
    .where('variant_id', 'in', variantIds)
    .orderBy('variant_id')
    .forUpdate()
    .execute();
  return new Map(rows.map((row) => [row.variant_id, row.id]));
}

async function insertPrices(
  trx: Db,
  priceListId: string | null,
  prices: readonly (PriceInput & { readonly priceSetId: string })[],
): Promise<void> {
  if (prices.length === 0) return;
  await trx
    .insertInto('price')
    .values(
      prices.map((price) => ({
        id: newId('price'),
        price_set_id: price.priceSetId,
        price_list_id: priceListId,
        currency: price.currency,
        amount: price.amount,
        channel_id: price.channelId ?? null,
        min_quantity: price.minQuantity ?? 1,
      })),
    )
    .execute();
}

function toPrice(row: {
  id: string;
  variant_id: string;
  price_list_id: string | null;
  currency: string;
  amount: string;
  channel_id: string | null;
  min_quantity: number;
}): Price {
  return {
    id: row.id,
    variantId: row.variant_id,
    priceListId: row.price_list_id,
    amount: money(Number(row.amount), row.currency),
    channelId: row.channel_id,
    minQuantity: row.min_quantity,
  };
}

function toPriceList(row: Selectable<PriceListTable>): PriceList {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    priority: row.priority,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
