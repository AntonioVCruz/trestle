/**
 * Display formatting for amounts the Store API returns in minor units. The storefront never adds
 * prices up; totals come from the server (wireframe rules).
 */

export interface FormatOptions {
  /** Drop the fraction when it is zero ("$24" rather than "$24.00"), as on product cards. */
  readonly compact?: boolean;
}

export function formatMoney(amount: number, currency: string, locale: string, { compact = false }: FormatOptions = {}): string {
  const digits = minorUnitDigits(currency, locale);
  const value = amount / 10 ** digits;
  const whole = amount % 10 ** digits === 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: compact && whole ? 0 : digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** "USD $", "EUR €": the code plus its symbol, for the currency picker. */
export function currencyLabel(currency: string, locale: string): string {
  const parts = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0);
  const symbol = parts.find((p) => p.type === 'currency')?.value;
  return symbol && symbol !== currency ? `${currency} ${symbol}` : currency;
}

function minorUnitDigits(currency: string, locale: string): number {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}
