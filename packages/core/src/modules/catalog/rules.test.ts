import { describe, expect, it } from 'vitest';
import { isHandle, planVariant, planVariants, productStatusMachine, type ProductOption } from './rules.js';

const shirt: ProductOption[] = [
  { name: 'Size', values: ['S', 'M'] },
  { name: 'Color', values: ['Blue', 'Red'] },
];

describe('handles', () => {
  it('accepts lowercase slugs only', () => {
    expect(isHandle('blue-t-shirt')).toBe(true);
    expect(isHandle('tee2')).toBe(true);
    for (const bad of ['', 'Blue', 'a--b', '-a', 'a-', 'a b', 'a_b', 'x'.repeat(101)]) expect(isHandle(bad)).toBe(false);
  });
});

describe('product status', () => {
  it('starts as draft and never publishes straight from the archive', () => {
    const m = productStatusMachine;
    expect(m.initial).toBe('draft');
    expect(m.can('draft', 'published')).toBe(true);
    expect(m.can('published', 'archived')).toBe(true);
    expect(m.can('archived', 'published')).toBe(false);
    expect(m.can('archived', 'draft')).toBe(true);
  });
});

describe('planVariants', () => {
  it('gives a product without options one default variant', () => {
    expect(planVariants([], [])).toEqual({ ok: true, value: [{ sku: null, title: 'Default', options: [] }] });
  });

  it('requires variants when the product has options', () => {
    expect(planVariants(shirt, [])).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('orders option values by option and derives titles', () => {
    const result = planVariants(shirt, [
      { sku: ' TEE-S-BLUE ', options: [{ name: 'Color', value: 'Blue' }, { name: 'Size', value: 'S' }] },
      { title: 'Medium red', options: [{ name: 'Size', value: 'M' }, { name: 'Color', value: 'Red' }] },
    ]);
    expect(result).toEqual({
      ok: true,
      value: [
        { sku: 'TEE-S-BLUE', title: 'S / Blue', options: [{ name: 'Size', value: 'S' }, { name: 'Color', value: 'Blue' }] },
        { sku: null, title: 'Medium red', options: [{ name: 'Size', value: 'M' }, { name: 'Color', value: 'Red' }] },
      ],
    });
  });

  it.each([
    ['a missing option', [{ name: 'Size', value: 'S' }], /exactly one value for option "Color"/],
    ['a repeated option', [{ name: 'Size', value: 'S' }, { name: 'Size', value: 'M' }, { name: 'Color', value: 'Red' }], /exactly one/],
    ['an unknown value', [{ name: 'Size', value: 'XL' }, { name: 'Color', value: 'Red' }], /"XL" is not a value/],
    ['an unknown option', [{ name: 'Size', value: 'S' }, { name: 'Color', value: 'Red' }, { name: 'Fit', value: 'Slim' }], /Unknown option "Fit"/],
  ])('rejects a variant with %s', (_, options, message) => {
    const result = planVariants(shirt, [{ options }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(message);
  });

  it('rejects duplicate combinations and SKUs', () => {
    const s = [{ name: 'Size', value: 'S' }, { name: 'Color', value: 'Red' }];
    const m = [{ name: 'Size', value: 'M' }, { name: 'Color', value: 'Red' }];
    expect(planVariants(shirt, [{ options: s }, { options: s }])).toMatchObject({ ok: false });
    expect(planVariants(shirt, [{ sku: 'X', options: s }, { sku: 'X', options: m }])).toMatchObject({
      ok: false,
      error: { message: 'Duplicate SKU "X"' },
    });
    expect(planVariants([], [{ sku: 'A' }, { sku: 'B' }])).toMatchObject({
      ok: false,
      error: { message: 'A product without options can only have one variant' },
    });
  });

  it.each([
    ['duplicate option names, ignoring case', [{ name: 'Size', values: ['S'] }, { name: 'size', values: ['M'] }]],
    ['an option without values', [{ name: 'Size', values: [] }]],
    ['duplicate values, ignoring case', [{ name: 'Color', values: ['Red', 'red'] }]],
    ['an untrimmed name', [{ name: ' Size', values: ['S'] }]],
    ['an empty value', [{ name: 'Size', values: [''] }]],
  ])('rejects %s', (_, options) => {
    expect(planVariants(options, [])).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
});

describe('planVariant', () => {
  it('checks a new variant against existing ones', () => {
    const existing = [{ options: [{ name: 'Size', value: 'S' }, { name: 'Color', value: 'Red' }] }];
    expect(
      planVariant(shirt, existing, { options: [{ name: 'Size', value: 'S' }, { name: 'Color', value: 'Red' }] }),
    ).toMatchObject({ ok: false, error: { message: 'Another variant already has the options Size=S, Color=Red' } });
    expect(
      planVariant(shirt, existing, { sku: 'TEE-M-RED', options: [{ name: 'Size', value: 'M' }, { name: 'Color', value: 'Red' }] }),
    ).toMatchObject({ ok: true, value: { sku: 'TEE-M-RED', title: 'M / Red' } });
  });
});
