import { randomBytes } from 'node:crypto';
import type { Selectable } from 'kysely';
import { isUniqueViolation, type CoreDatabase } from '../../kernel/db.js';
import { newId } from '../../kernel/id.js';
import { isCurrencyCode } from '../../kernel/money.js';
import { recordEvent, type OutboxTables } from '../../kernel/outbox.js';
import { err, ok, type DomainError, type Result } from '../../kernel/result.js';
import type { ChannelTable, ChannelTables } from './tables.js';

/**
 * A channel is one storefront: its currencies, locales and, later, its catalog visibility,
 * price lists, stock locations and tax zone (ADR 0004). Store API callers select it with a
 * publishable key.
 */
export interface Channel {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly defaultCurrency: string;
  readonly currencies: readonly string[];
  readonly defaultLocale: string;
  readonly locales: readonly string[];
  readonly createdAt: Date;
}

export interface PublishableKey {
  readonly key: string;
  readonly channelId: string;
  readonly createdAt: Date;
}

export interface CreateChannelInput {
  readonly code: string;
  readonly name: string;
  readonly defaultCurrency: string;
  readonly currencies?: readonly string[];
  readonly defaultLocale: string;
  readonly locales?: readonly string[];
}

export type CreateChannelError = DomainError<'invalid_input' | 'channel_code_taken'>;
export type CreatePublishableKeyError = DomainError<'channel_not_found'>;

export interface ChannelService {
  list(): Promise<Channel[]>;
  getById(id: string): Promise<Channel | undefined>;
  /** Resolves an active (not revoked) publishable key to its channel. */
  getByPublishableKey(key: string): Promise<Channel | undefined>;
  create(input: CreateChannelInput): Promise<Result<Channel, CreateChannelError>>;
  createPublishableKey(channelId: string): Promise<Result<PublishableKey, CreatePublishableKeyError>>;
}

export const CHANNEL_CREATED = 'channel.created';

export function createChannelService(database: CoreDatabase): ChannelService {
  const db = database.withTables<ChannelTables & OutboxTables>();

  const getById = async (id: string) => {
    const row = await db.selectFrom('channel').selectAll().where('id', '=', id).executeTakeFirst();
    return row && toChannel(row);
  };

  return {
    async list() {
      const rows = await db.selectFrom('channel').selectAll().orderBy('created_at').execute();
      return rows.map(toChannel);
    },

    getById,

    async getByPublishableKey(key) {
      const row = await db
        .selectFrom('channel_publishable_key as k')
        .innerJoin('channel as c', 'c.id', 'k.channel_id')
        .selectAll('c')
        .where('k.key', '=', key)
        .where('k.revoked_at', 'is', null)
        .executeTakeFirst();
      return row && toChannel(row);
    },

    async create(input) {
      const currencies = unique([input.defaultCurrency, ...(input.currencies ?? [])]);
      const locales = unique([input.defaultLocale, ...(input.locales ?? [])]);
      const badCurrency = currencies.find((c) => !isCurrencyCode(c));
      if (badCurrency) return err('invalid_input', `Invalid currency code "${badCurrency}"`);

      try {
        const row = await db.transaction().execute(async (trx) => {
          const inserted = await trx
            .insertInto('channel')
            .values({
              id: newId('chn'),
              code: input.code,
              name: input.name,
              default_currency: input.defaultCurrency,
              currencies,
              default_locale: input.defaultLocale,
              locales,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordEvent(trx, CHANNEL_CREATED, { id: inserted.id, code: inserted.code });
          return inserted;
        });
        return ok(toChannel(row));
      } catch (error) {
        if (isUniqueViolation(error)) {
          return err('channel_code_taken', `A channel with code "${input.code}" already exists`);
        }
        throw error;
      }
    },

    async createPublishableKey(channelId) {
      if (!(await getById(channelId))) return err('channel_not_found', `Channel "${channelId}" not found`);
      const row = await db
        .insertInto('channel_publishable_key')
        .values({ key: `pk_${randomBytes(24).toString('base64url')}`, channel_id: channelId, revoked_at: null })
        .returningAll()
        .executeTakeFirstOrThrow();
      return ok({ key: row.key, channelId: row.channel_id, createdAt: row.created_at });
    },
  };
}

function toChannel(row: Selectable<ChannelTable>): Channel {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    defaultCurrency: row.default_currency,
    currencies: row.currencies,
    defaultLocale: row.default_locale,
    locales: row.locales,
    createdAt: row.created_at,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
