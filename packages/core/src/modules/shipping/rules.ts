import { isCurrencyCode, type CurrencyCode } from '../../kernel/money.js';
import { err, ok, type DomainError, type Result } from '../../kernel/result.js';

const COUNTRY = /^[A-Z]{2}$/;

/** ISO 3166-1 alpha-2, e.g. "DE". */
export function isCountryCode(value: string): boolean {
  return COUNTRY.test(value);
}

export interface ShippingPriceInput {
  readonly currency: CurrencyCode;
  /** Minor units. */
  readonly amount: number;
}

export type InvalidInput = DomainError<'invalid_input'>;

export function checkShippingPrices(prices: readonly ShippingPriceInput[]): Result<void, InvalidInput> {
  if (prices.length === 0) return err('invalid_input', 'A shipping option needs at least one price');
  const seen = new Set<string>();
  for (const { currency, amount } of prices) {
    if (!isCurrencyCode(currency)) return err('invalid_input', `Invalid currency code "${currency}"`);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      return err('invalid_input', `Amount must be a non-negative integer in minor units, got ${amount}`);
    }
    if (seen.has(currency)) return err('invalid_input', `Duplicate price for ${currency}`);
    seen.add(currency);
  }
  return ok(undefined);
}

/** Null means every country. An empty list would make the option unusable, so it is refused. */
export function checkCountries(countries: readonly string[] | null): Result<void, InvalidInput> {
  if (countries === null) return ok(undefined);
  if (countries.length === 0) return err('invalid_input', 'Omit countries to ship everywhere; an empty list ships nowhere');
  const bad = countries.find((c) => !isCountryCode(c));
  if (bad) return err('invalid_input', `Invalid country code "${bad}"`);
  return ok(undefined);
}
