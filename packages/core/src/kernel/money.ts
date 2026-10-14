/** ISO 4217 alphabetic code, e.g. "EUR". */
export type CurrencyCode = string;

/**
 * An amount in the currency's minor unit (cents for EUR/USD, yen for JPY).
 * Amounts are always safe integers; floats never enter money arithmetic (ADR 0006).
 */
export interface Money {
  readonly amount: number;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  constructor(
    readonly expected: CurrencyCode,
    readonly actual: CurrencyCode,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
    this.name = 'CurrencyMismatchError';
  }
}

const CURRENCY_CODE = /^[A-Z]{3}$/;

export function isCurrencyCode(value: string): boolean {
  return CURRENCY_CODE.test(value);
}

export function money(amount: number, currency: CurrencyCode): Money {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`Money amount must be a safe integer in minor units, got ${amount}`);
  }
  if (!isCurrencyCode(currency)) {
    throw new RangeError(`Invalid currency code "${currency}"`);
  }
  return Object.freeze({ amount, currency });
}

export function zero(currency: CurrencyCode): Money {
  return money(0, currency);
}

export function assertCurrency(value: Money, currency: CurrencyCode): void {
  if (value.currency !== currency) throw new CurrencyMismatchError(currency, value.currency);
}

export function add(a: Money, b: Money): Money {
  assertCurrency(b, a.currency);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertCurrency(b, a.currency);
  return money(a.amount - b.amount, a.currency);
}

export function negate(value: Money): Money {
  return money(-value.amount, value.currency);
}

/** Multiply by an integer (e.g. a quantity). Fractions need an explicit rounding rule; use allocate(). */
export function multiply(value: Money, factor: number): Money {
  if (!Number.isSafeInteger(factor)) {
    throw new RangeError(`Money can only be multiplied by an integer, got ${factor}`);
  }
  return money(value.amount * factor, value.currency);
}

export function sum(values: readonly Money[], currency: CurrencyCode): Money {
  return values.reduce(add, zero(currency));
}

/**
 * Split `total` across `weights` proportionally without losing or inventing minor units
 * (largest-remainder method). Used to prorate order-level discounts and charges across lines.
 * If every weight is zero the total is split evenly.
 */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) throw new RangeError('allocate() needs at least one weight');
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new RangeError('allocate() weights must be non-negative integers');
  }

  const effective = weights.every((w) => w === 0) ? weights.map(() => 1) : weights;
  const sign = total.amount < 0 ? -1n : 1n;
  const amount = BigInt(Math.abs(total.amount));
  const weightSum = effective.reduce((acc, w) => acc + BigInt(w), 0n);

  const shares = effective.map((w, index) => {
    const exact = amount * BigInt(w);
    return { index, units: exact / weightSum, remainder: exact % weightSum };
  });

  let leftover = amount - shares.reduce((acc, s) => acc + s.units, 0n);
  const byRemainder = [...shares].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const share of byRemainder) {
    if (leftover === 0n) break;
    share.units += 1n;
    leftover -= 1n;
  }

  return shares.map((s) => money(Number(s.units * sign), total.currency));
}
