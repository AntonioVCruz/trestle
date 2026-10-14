import { describe, expect, it } from 'vitest';
import { add, allocate, CurrencyMismatchError, money, multiply, subtract, sum } from './money.js';

const eur = (amount: number) => money(amount, 'EUR');

describe('money', () => {
  it('rejects fractional amounts and malformed currencies', () => {
    expect(() => money(10.5, 'EUR')).toThrow(RangeError);
    expect(() => money(10, 'eur')).toThrow(RangeError);
  });

  it('adds, subtracts and multiplies within one currency', () => {
    expect(add(eur(150), eur(250))).toEqual(eur(400));
    expect(subtract(eur(150), eur(250))).toEqual(eur(-100));
    expect(multiply(eur(199), 3)).toEqual(eur(597));
    expect(sum([eur(1), eur(2), eur(3)], 'EUR')).toEqual(eur(6));
  });

  it('refuses to mix currencies', () => {
    expect(() => add(eur(1), money(1, 'USD'))).toThrow(CurrencyMismatchError);
  });

  it('refuses fractional multiplication', () => {
    expect(() => multiply(eur(100), 0.2)).toThrow(RangeError);
  });
});

describe('allocate', () => {
  it('never loses or invents a cent', () => {
    const parts = allocate(eur(100), [1, 1, 1]);
    expect(parts.map((p) => p.amount)).toEqual([34, 33, 33]);
    expect(sum(parts, 'EUR')).toEqual(eur(100));
  });

  it('splits proportionally to weights', () => {
    expect(allocate(eur(1000), [3000, 1000]).map((p) => p.amount)).toEqual([750, 250]);
  });

  it('keeps the sign of negative totals (discounts)', () => {
    const parts = allocate(eur(-10), [2, 1]);
    expect(parts.map((p) => p.amount)).toEqual([-7, -3]);
  });

  it('splits evenly when every weight is zero', () => {
    expect(allocate(eur(5), [0, 0]).map((p) => p.amount)).toEqual([3, 2]);
  });

  it('handles products beyond 2^53 without precision loss', () => {
    const big = Number.MAX_SAFE_INTEGER - 1;
    const parts = allocate(eur(big), [big, 1]);
    expect(sum(parts, 'EUR')).toEqual(eur(big));
  });
});
