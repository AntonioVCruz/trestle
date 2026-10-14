import { describe, expect, it } from 'vitest';
import { cartErrorMessage, isCurrencyLocked, lineTitle, needsNewCart, shopCurrency, unavailableLines } from './cart.js';

const line = (available = true) => ({ available });
const cart = (currency: string, lines: { available: boolean }[]) => ({ currency, lines });

describe('lineTitle', () => {
  it('names the variant, except the default one of a product without options', () => {
    expect(lineTitle({ productTitle: 'Linen Tee', variantTitle: 'M / Red' })).toBe('Linen Tee — M / Red');
    expect(lineTitle({ productTitle: 'Canvas Tote', variantTitle: 'Default' })).toBe('Canvas Tote');
  });
});

describe('currency and the cart (2b)', () => {
  it('locks once the cart holds a line, available or not', () => {
    expect(isCurrencyLocked(null)).toBe(false);
    expect(isCurrencyLocked(cart('USD', []))).toBe(false);
    expect(isCurrencyLocked(cart('USD', [line(false)]))).toBe(true);
  });

  it('shows prices in the cart’s currency while locked, else in the shopper’s pick', () => {
    expect(shopCurrency(cart('USD', [line()]), 'EUR')).toBe('USD');
    expect(shopCurrency(cart('USD', []), 'EUR')).toBe('EUR');
    expect(shopCurrency(null, 'EUR')).toBe('EUR');
  });

  it('starts a new cart when there is none, or an empty one in another currency', () => {
    expect(needsNewCart(null, 'USD')).toBe(true);
    expect(needsNewCart(cart('USD', []), 'EUR')).toBe(true);
    expect(needsNewCart(cart('USD', []), 'USD')).toBe(false);
    expect(needsNewCart(cart('USD', [line()]), 'EUR')).toBe(false);
  });
});

describe('unavailableLines', () => {
  it('finds the lines that block checkout (3b)', () => {
    expect(unavailableLines(cart('USD', [line(), line(false)]))).toEqual([line(false)]);
  });
});

describe('cartErrorMessage', () => {
  it('explains known failures and falls back for the rest', () => {
    expect(cartErrorMessage('variant_not_available')).toMatch(/no longer available/);
    expect(cartErrorMessage('invalid_request')).toMatch(/between 1 and 1000/);
    expect(cartErrorMessage('something_new')).toMatch(/try again/);
  });
});
