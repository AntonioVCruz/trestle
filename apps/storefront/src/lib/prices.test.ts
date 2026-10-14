import { describe, expect, it } from 'vitest';
import { priceText, summarizePrice, wasAmount } from './prices.js';
import type { Price, Variant } from './types.js';

const price = (amount: number, originalAmount: number | null = null): Price => ({ amount, currency: 'USD', originalAmount });
const variant = (p: Price | null): Variant => ({ id: `var_${Math.random()}`, sku: null, title: 'V', options: [], price: p });

describe('summarizePrice', () => {
  it('shows a single price when every variant costs the same', () => {
    expect(summarizePrice({ variants: [variant(price(2200)), variant(price(2200))] })).toEqual({ price: price(2200), from: false });
  });

  it('reads "From" the cheapest variant when prices differ', () => {
    const summary = summarizePrice({ variants: [variant(price(2800)), variant(price(2400, 3000)), variant(price(2600))] });
    expect(summary).toEqual({ price: price(2400, 3000), from: true });
  });

  it('ignores variants without a price in this currency', () => {
    expect(summarizePrice({ variants: [variant(null), variant(price(3500))] })).toEqual({ price: price(3500), from: false });
  });

  it('is null when nothing is priced', () => {
    expect(summarizePrice({ variants: [variant(null)] })).toBeNull();
  });
});

describe('priceText', () => {
  it('reads a regular price as is', () => {
    expect(priceText({ price: price(2800), from: false }, 'en')).toEqual({ now: '$28.00', was: null, saving: null, spoken: '$28.00' });
  });

  it('spells a sale out for screen readers', () => {
    expect(priceText({ price: price(2200, 2800), from: true }, 'en', true)).toEqual({
      now: 'From $22',
      was: '$28',
      saving: 'Save $6',
      spoken: 'On sale from $22, was $28',
    });
    expect(priceText({ price: price(2200, 2800), from: false }, 'en').spoken).toBe('Sale price $22.00, was $28.00');
  });
});

describe('wasAmount', () => {
  it('strikes the original only when it is higher than the current price', () => {
    expect(wasAmount(price(2200, 2800))).toBe(2800);
    expect(wasAmount(price(2200, 2200))).toBeNull();
    expect(wasAmount(price(2200))).toBeNull();
  });
});
