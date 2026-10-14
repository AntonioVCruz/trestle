import { isCurrencyCode, type CurrencyCode, type Money } from '../../kernel/money.js';
import { err, ok, type DomainError, type Result } from '../../kernel/result.js';

export type PriceListStatus = 'draft' | 'active';

/**
 * `override` lists replace the regular price, cheaper or not (contract or surcharge pricing).
 * `sale` lists apply only when they undercut the regular price at that quantity.
 */
export type PriceListType = 'sale' | 'override';

export interface PriceInput {
  readonly currency: CurrencyCode;
  /** Minor units (cents). */
  readonly amount: number;
  /** Limits the price to one channel; omit for every channel. */
  readonly channelId?: string | null;
  /** Tier pricing: the price applies from this quantity up. Defaults to 1. */
  readonly minQuantity?: number;
}

/** A price as the resolver sees it, with the list it belongs to, if any. */
export interface PriceCandidate {
  readonly id: string;
  readonly amount: Money;
  readonly channelId: string | null;
  readonly minQuantity: number;
  readonly list: {
    readonly id: string;
    readonly type: PriceListType;
    readonly status: PriceListStatus;
    readonly priority: number;
    readonly startsAt: Date | null;
    readonly endsAt: Date | null;
  } | null;
}

export interface PriceContext {
  readonly currency: CurrencyCode;
  readonly channelId: string;
  readonly quantity: number;
  readonly at: Date;
}

export interface ResolvedPrice {
  readonly priceId: string;
  readonly amount: Money;
  readonly priceListId: string | null;
  /** The regular price a sale undercuts, for "was" displays; null when no sale applies. */
  readonly original: Money | null;
}

export type InvalidInput = DomainError<'invalid_input'>;

/** Validates prices that will replace a variant's base prices or a price list's prices. */
export function checkPrices(prices: readonly PriceInput[]): Result<void, InvalidInput> {
  const seen = new Set<string>();
  for (const price of prices) {
    if (!isCurrencyCode(price.currency)) return err('invalid_input', `Invalid currency code "${price.currency}"`);
    if (!Number.isSafeInteger(price.amount) || price.amount < 0) {
      return err('invalid_input', `Amount must be a non-negative integer in minor units, got ${price.amount}`);
    }
    const minQuantity = price.minQuantity ?? 1;
    if (!Number.isSafeInteger(minQuantity) || minQuantity < 1) {
      return err('invalid_input', `Minimum quantity must be a positive integer, got ${minQuantity}`);
    }
    const key = JSON.stringify([price.currency, price.channelId ?? null, minQuantity]);
    if (seen.has(key)) {
      return err(
        'invalid_input',
        `Duplicate price for ${price.currency}, channel ${price.channelId ?? 'any'}, from quantity ${minQuantity}`,
      );
    }
    seen.add(key);
  }
  return ok(undefined);
}

export function checkPriceListWindow(startsAt: Date | null, endsAt: Date | null): Result<void, InvalidInput> {
  if (startsAt && endsAt && endsAt <= startsAt) return err('invalid_input', 'A price list must end after it starts');
  return ok(undefined);
}

/** A list price applies only while its list is active and inside its validity window. */
export function isListLive(list: NonNullable<PriceCandidate['list']>, at: Date): boolean {
  return (
    list.status === 'active' &&
    (list.startsAt === null || list.startsAt <= at) &&
    (list.endsAt === null || at < list.endsAt)
  );
}

/**
 * Picks the price that applies in a context (ADR 0014):
 * 1. Only prices in the context's currency, for its channel or for every channel, whose
 *    minimum quantity is reached, and whose list (if any) is live, are eligible.
 * 2. The regular price is the best live override price if there is one, else the best base
 *    price.
 * 3. A live sale price applies only if it is lower than the regular price; the regular price is
 *    then reported as `original`. With no regular price at all, the best sale price applies.
 *
 * "Best" means: higher list priority first, then channel-specific over any-channel, then the
 * highest quantity tier reached, then the lower amount, then the lower id, so the result is
 * always deterministic.
 */
export function resolvePrice(candidates: readonly PriceCandidate[], context: PriceContext): ResolvedPrice | null {
  const eligible = candidates.filter(
    (c) =>
      c.amount.currency === context.currency &&
      (c.channelId === null || c.channelId === context.channelId) &&
      c.minQuantity <= context.quantity &&
      (c.list === null || isListLive(c.list, context.at)),
  );
  const regular = pick(eligible.filter((c) => c.list?.type === 'override')) ?? pick(eligible.filter((c) => c.list === null));
  const sale = pick(
    eligible.filter((c) => c.list?.type === 'sale' && (!regular || c.amount.amount < regular.amount.amount)),
  );

  if (sale) {
    return { priceId: sale.id, amount: sale.amount, priceListId: sale.list!.id, original: regular?.amount ?? null };
  }
  if (!regular) return null;
  return { priceId: regular.id, amount: regular.amount, priceListId: regular.list?.id ?? null, original: null };
}

function pick(candidates: readonly PriceCandidate[]): PriceCandidate | undefined {
  return [...candidates].sort(compare)[0];
}

function compare(a: PriceCandidate, b: PriceCandidate): number {
  return (
    (b.list?.priority ?? 0) - (a.list?.priority ?? 0) ||
    Number(b.channelId !== null) - Number(a.channelId !== null) ||
    b.minQuantity - a.minQuantity ||
    a.amount.amount - b.amount.amount ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
