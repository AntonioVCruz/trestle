import { describe, expect, it } from 'vitest';
import { chooseCurrency, safeReturnPath, withParams } from './shopper.js';

describe('withParams', () => {
  it('adds and replaces query parameters on a path', () => {
    expect(withParams('/cart', { added: 'line_1' })).toBe('/cart?added=line_1');
    expect(withParams('/fragments/cart?error=x', { error: 'cart_full' })).toBe('/fragments/cart?error=cart_full');
  });
});

describe('chooseCurrency', () => {
  const channel = { currencies: ['USD', 'EUR'], defaultCurrency: 'USD' };

  it('keeps a remembered currency the channel offers', () => {
    expect(chooseCurrency(channel, 'EUR')).toBe('EUR');
  });

  it('falls back to the default otherwise', () => {
    expect(chooseCurrency(channel, undefined)).toBe('USD');
    expect(chooseCurrency(channel, 'GBP')).toBe('USD');
  });
});

describe('safeReturnPath', () => {
  it('accepts paths on this site', () => {
    expect(safeReturnPath('/categories/tops?after=abc')).toBe('/categories/tops?after=abc');
  });

  it('rejects anything that could leave the site', () => {
    for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', 'tops', undefined, 42]) {
      expect(safeReturnPath(value)).toBe('/');
    }
  });
});
