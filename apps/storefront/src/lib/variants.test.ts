import { describe, expect, it } from 'vitest';
import type { Product, Variant } from './types.js';
import { initialPicks, optionParam, pick, purchaseState, resolveVariant, valueState } from './variants.js';

const variant = (id: string, size: string, color: string): Variant => ({
  id,
  sku: id.toUpperCase(),
  title: `${size} / ${color}`,
  options: [
    { name: 'Size', value: size },
    { name: 'Color', value: color },
  ],
  price: { amount: 2800, currency: 'USD', originalAmount: null },
});

// Every combination except M / Black, as in wireframe 1h.
const tee: Pick<Product, 'options' | 'variants'> = {
  options: [
    { name: 'Size', values: ['S', 'M', 'L'] },
    { name: 'Color', values: ['Blue', 'Red', 'Black'] },
  ],
  variants: [
    variant('s-blue', 'S', 'Blue'),
    variant('s-red', 'S', 'Red'),
    variant('s-black', 'S', 'Black'),
    variant('m-blue', 'M', 'Blue'),
    variant('m-red', 'M', 'Red'),
    variant('l-red', 'L', 'Red'),
    variant('l-black', 'L', 'Black'),
  ],
};

const tote: Pick<Product, 'options' | 'variants'> = {
  options: [],
  variants: [{ id: 'default', sku: 'CT-001', title: 'Default', options: [], price: null }],
};

describe('initialPicks', () => {
  it('opens on the shared variant', () => {
    expect(initialPicks(tee, new URLSearchParams('variant=m-red'))).toEqual({ Size: 'M', Color: 'Red' });
  });

  it('takes values picked without JavaScript, ignoring unknown ones', () => {
    const search = new URLSearchParams([
      [optionParam('Size'), 'L'],
      [optionParam('Color'), 'Purple'],
    ]);
    expect(initialPicks(tee, search)).toEqual({ Size: 'L' });
  });

  it('falls back to the first variant', () => {
    expect(initialPicks(tee, new URLSearchParams('variant=nope'))).toEqual({ Size: 'S', Color: 'Blue' });
    expect(initialPicks(tote, new URLSearchParams())).toEqual({});
  });
});

describe('resolveVariant', () => {
  it('resolves once every option is picked', () => {
    expect(resolveVariant(tee, { Size: 'M', Color: 'Red' })?.id).toBe('m-red');
    expect(resolveVariant(tee, { Size: 'M' })).toBeUndefined();
  });

  it('resolves the default variant of a product without options', () => {
    expect(resolveVariant(tote, {})?.id).toBe('default');
  });
});

describe('valueState', () => {
  it('marks values that do not combine with the other picks as unavailable', () => {
    const picks = { Size: 'M', Color: 'Red' };
    expect(valueState(tee, picks, 'Size', 'M')).toBe('selected');
    expect(valueState(tee, picks, 'Color', 'Blue')).toBe('available');
    expect(valueState(tee, picks, 'Color', 'Black')).toBe('unavailable');
    expect(valueState(tee, picks, 'Size', 'L')).toBe('available');
  });
});

describe('purchaseState', () => {
  it('offers Add to cart for a priced variant', () => {
    expect(purchaseState(tee, { Size: 'M', Color: 'Red' }, 'USD')).toEqual({ variantId: 'm-red', label: 'Add to cart' });
  });

  it('says which option is still missing', () => {
    expect(purchaseState(tee, { Color: 'Black' }, 'USD')).toEqual({ variantId: null, label: 'Select a size' });
  });

  it('refuses a variant with no price in this currency', () => {
    expect(purchaseState(tote, {}, 'EUR')).toEqual({ variantId: null, label: 'Not available in EUR' });
  });
});

describe('pick', () => {
  it('keeps the other picks when the combination exists', () => {
    expect(pick(tee, { Size: 'S', Color: 'Red' }, 'Size', 'M')).toEqual({ Size: 'M', Color: 'Red' });
  });

  it('clears, never swaps, a pick that no longer combines', () => {
    expect(pick(tee, { Size: 'S', Color: 'Black' }, 'Size', 'M')).toEqual({ Size: 'M' });
    expect(pick(tee, { Size: 'M', Color: 'Red' }, 'Color', 'Black')).toEqual({ Color: 'Black' });
  });
});
