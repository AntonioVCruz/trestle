import { formatMoney } from './money.js';
import type { Price, Product } from './types.js';

export interface PriceSummary {
  /** The lowest current unit price among the product's variants. */
  readonly price: Price;
  /** The variants are not all priced the same, so the price reads "From …". */
  readonly from: boolean;
}

/**
 * What a product card shows: the cheapest variant's price, and whether others cost more. Null
 * when no variant has a price in the requested currency.
 */
export function summarizePrice(product: Pick<Product, 'variants'>): PriceSummary | null {
  const prices = product.variants.flatMap((v) => (v.price ? [v.price] : []));
  const [first, ...rest] = prices;
  if (!first) return null;
  const lowest = rest.reduce((min, p) => (p.amount < min.amount ? p : min), first);
  return { price: lowest, from: prices.some((p) => p.amount !== lowest.amount) };
}

/** The regular price to strike through, when a sale undercuts it (wireframe 3a). */
export function wasAmount(price: Price): number | null {
  return price.originalAmount !== null && price.originalAmount > price.amount ? price.originalAmount : null;
}

export interface PriceText {
  /** "From $22" or "$22.00". */
  readonly now: string;
  /** The struck-through regular price during a sale. */
  readonly was: string | null;
  /** "Save $6.00", for the product page. */
  readonly saving: string | null;
  /** The whole thing in words, because `<s>` alone is not announced (wireframe 3a). */
  readonly spoken: string;
}

/** Display strings for a price, shared by the server-rendered page and the browser script. */
export function priceText({ price, from }: PriceSummary, locale: string, compact = false): PriceText {
  const format = (amount: number) => formatMoney(amount, price.currency, locale, { compact });
  const prefix = from ? 'From ' : '';
  const now = `${prefix}${format(price.amount)}`;
  const was = wasAmount(price);
  if (was === null) return { now, was: null, saving: null, spoken: now };
  return {
    now,
    was: format(was),
    saving: `Save ${format(was - price.amount)}`,
    spoken: `${from ? 'On sale from' : 'Sale price'} ${format(price.amount)}, was ${format(was)}`,
  };
}
