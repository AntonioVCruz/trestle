import { sql, type Kysely, type Selectable } from 'kysely';
import type { CoreDatabase } from '../../kernel/db.js';
import { newId } from '../../kernel/id.js';
import { money, type CurrencyCode, type Money } from '../../kernel/money.js';
import { recordEvent, type OutboxTables } from '../../kernel/outbox.js';
import { err, ok, type DomainError, type Result } from '../../kernel/result.js';
import { checkCountries, checkShippingPrices, type ShippingPriceInput } from './rules.js';
import type { ShippingOptionPriceTable, ShippingOptionTable, ShippingTables } from './tables.js';

/**
 * Shipping options a channel offers at checkout (ADR 0016): a flat price per currency, limited
 * to some countries or not. Carrier rates, weight-based pricing and zones come later.
 */
export interface ShippingOption {
  readonly id: string;
  readonly channelId: string;
  readonly name: string;
  readonly countries: readonly string[] | null;
  readonly active: boolean;
  readonly prices: readonly Money[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What one option costs for one checkout. */
export interface ShippingQuote {
  readonly optionId: string;
  readonly name: string;
  readonly amount: Money;
}

export interface QuoteContext {
  readonly channelId: string;
  readonly currency: CurrencyCode;
  readonly country: string;
}

export interface CreateShippingOptionInput {
  /** Callers check the channel exists and sells in each price's currency. */
  readonly channelId: string;
  readonly name: string;
  readonly countries?: readonly string[] | null;
  readonly active?: boolean;
  readonly prices: readonly ShippingPriceInput[];
}

export interface UpdateShippingOptionInput {
  readonly name?: string;
  readonly countries?: readonly string[] | null;
  readonly active?: boolean;
  /** Replaces every price. */
  readonly prices?: readonly ShippingPriceInput[];
}

export type CreateShippingOptionError = DomainError<'invalid_input'>;
export type UpdateShippingOptionError = DomainError<'invalid_input' | 'shipping_option_not_found'>;

export interface ShippingService {
  listOptions(filter?: { readonly channelId?: string }): Promise<ShippingOption[]>;
  getOption(id: string): Promise<ShippingOption | undefined>;
  createOption(input: CreateShippingOptionInput): Promise<Result<ShippingOption, CreateShippingOptionError>>;
  updateOption(id: string, input: UpdateShippingOptionInput): Promise<Result<ShippingOption, UpdateShippingOptionError>>;
  /** Active options of the channel that ship to the country and have a price in the currency. */
  quotes(context: QuoteContext): Promise<ShippingQuote[]>;
}

export const SHIPPING_OPTION_CREATED = 'shipping_option.created';
export const SHIPPING_OPTION_UPDATED = 'shipping_option.updated';

type Db = Kysely<ShippingTables & OutboxTables>;

export function createShippingService(database: CoreDatabase): ShippingService {
  const db: Db = database.withTables<ShippingTables & OutboxTables>();

  const load = async (conn: Db, rows: readonly Selectable<ShippingOptionTable>[]) => {
    if (rows.length === 0) return [];
    const prices = await conn
      .selectFrom('shipping_option_price')
      .selectAll()
      .where(
        'option_id',
        'in',
        rows.map((r) => r.id),
      )
      .orderBy('currency')
      .execute();
    return rows.map((row) => toOption(row, prices.filter((p) => p.option_id === row.id)));
  };

  const getOption = async (conn: Db, id: string) => {
    const row = await conn.selectFrom('shipping_option').selectAll().where('id', '=', id).executeTakeFirst();
    return row && (await load(conn, [row]))[0];
  };

  async function replacePrices(trx: Db, optionId: string, prices: readonly ShippingPriceInput[]) {
    await trx.deleteFrom('shipping_option_price').where('option_id', '=', optionId).execute();
    await trx
      .insertInto('shipping_option_price')
      .values(prices.map((p) => ({ option_id: optionId, currency: p.currency, amount: p.amount })))
      .execute();
  }

  return {
    async listOptions(filter = {}) {
      const rows = await db
        .selectFrom('shipping_option')
        .selectAll()
        .$if(filter.channelId !== undefined, (q) => q.where('channel_id', '=', filter.channelId!))
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return load(db, rows);
    },

    getOption: (id) => getOption(db, id),

    async createOption(input) {
      if (!input.name.trim()) return err('invalid_input', 'Name must not be empty');
      const countries = input.countries ?? null;
      for (const checked of [checkShippingPrices(input.prices), checkCountries(countries)]) {
        if (!checked.ok) return checked;
      }
      const option = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('shipping_option')
          .values({
            id: newId('ship'),
            channel_id: input.channelId,
            name: input.name,
            countries: countries && [...new Set(countries)],
            active: input.active ?? true,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await replacePrices(trx, row.id, input.prices);
        await recordEvent(trx, SHIPPING_OPTION_CREATED, { id: row.id, channelId: row.channel_id });
        return (await getOption(trx, row.id))!;
      });
      return ok(option);
    },

    async updateOption(id, input) {
      if (input.name !== undefined && !input.name.trim()) return err('invalid_input', 'Name must not be empty');
      if (input.prices !== undefined) {
        const checked = checkShippingPrices(input.prices);
        if (!checked.ok) return checked;
      }
      if (input.countries !== undefined) {
        const checked = checkCountries(input.countries);
        if (!checked.ok) return checked;
      }

      return db.transaction().execute(async (trx): Promise<Result<ShippingOption, UpdateShippingOptionError>> => {
        const current = await trx.selectFrom('shipping_option').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
        if (!current) return err('shipping_option_not_found', `Shipping option "${id}" not found`);
        await trx
          .updateTable('shipping_option')
          .set({
            ...(input.name !== undefined && { name: input.name }),
            ...(input.countries !== undefined && { countries: input.countries && [...new Set(input.countries)] }),
            ...(input.active !== undefined && { active: input.active }),
            updated_at: sql<Date>`now()`,
          })
          .where('id', '=', id)
          .execute();
        if (input.prices !== undefined) await replacePrices(trx, id, input.prices);
        await recordEvent(trx, SHIPPING_OPTION_UPDATED, { id });
        return ok((await getOption(trx, id))!);
      });
    },

    async quotes({ channelId, currency, country }) {
      const rows = await db
        .selectFrom('shipping_option as o')
        .innerJoin('shipping_option_price as p', 'p.option_id', 'o.id')
        .select(['o.id', 'o.name', 'p.amount'])
        .where('o.channel_id', '=', channelId)
        .where('o.active', '=', true)
        .where('p.currency', '=', currency)
        .where((eb) => eb.or([eb('o.countries', 'is', null), eb(sql<string>`${country}`, '=', eb.fn.any('o.countries'))]))
        .orderBy('p.amount')
        .orderBy('o.name')
        .execute();
      return rows.map((row) => ({ optionId: row.id, name: row.name, amount: money(Number(row.amount), currency) }));
    },
  };
}

function toOption(row: Selectable<ShippingOptionTable>, prices: readonly Selectable<ShippingOptionPriceTable>[]): ShippingOption {
  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    countries: row.countries,
    active: row.active,
    prices: prices.map((p) => money(Number(p.amount), p.currency)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
