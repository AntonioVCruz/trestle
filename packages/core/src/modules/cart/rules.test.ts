import { describe, expect, it } from 'vitest';
import { money } from '../../kernel/money.js';
import type { Adjuster } from '../../kernel/totals.js';
import {
  addLine,
  cartTotals,
  MAX_LINE_QUANTITY,
  MAX_LINES,
  priceLines,
  removeLine,
  setLineQuantity,
  type CartLineState,
  type LinePrice,
  type SellableVariant,
} from './rules.js';

const eur = (amount: number) => money(amount, 'EUR');

function line(id: string, variantId: string, quantity: number, unit = 1000, available = true): CartLineState {
  return {
    id,
    variantId,
    quantity,
    productId: 'prod_1',
    productHandle: 'tee',
    productTitle: 'T-shirt',
    variantTitle: variantId,
    sku: null,
    unitPrice: eur(unit),
    originalUnitPrice: null,
    available,
  };
}

const sellable = (...ids: string[]) =>
  new Map<string, SellableVariant>(
    ids.map((variantId) => [
      variantId,
      { variantId, productId: 'prod_1', productHandle: 'tee-new', productTitle: 'T-shirt v2', variantTitle: `${variantId}!`, sku: 'SKU' },
    ]),
  );
const priced = (entries: Record<string, number>) =>
  new Map<string, LinePrice>(Object.entries(entries).map(([id, amount]) => [id, { unitPrice: eur(amount), originalUnitPrice: null }]));

describe('line operations', () => {
  const lines = [line('line_1', 'var_a', 2)];
  const newId = () => 'line_new';

  it('adds a new variant as a new line', () => {
    expect(addLine(lines, 'var_b', 1, newId)).toMatchObject({
      ok: true,
      value: [{ id: 'line_1', quantity: 2 }, { id: 'line_new', variantId: 'var_b', quantity: 1 }],
    });
  });

  it('raises the quantity of a variant already in the cart', () => {
    const result = addLine(lines, 'var_a', 3, newId);
    expect(result).toMatchObject({ ok: true, value: [{ id: 'line_1', quantity: 5 }] });
    expect(result.ok && result.value).toHaveLength(1);
  });

  it('enforces quantity and line limits', () => {
    for (const q of [0, -1, 1.5, MAX_LINE_QUANTITY + 1]) {
      expect(addLine(lines, 'var_b', q, newId)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    }
    expect(addLine(lines, 'var_a', MAX_LINE_QUANTITY - 1, newId)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    const full = Array.from({ length: MAX_LINES }, (_, i) => line(`line_${i}`, `var_${i}`, 1));
    expect(addLine(full, 'var_extra', 1, newId)).toMatchObject({ ok: false, error: { code: 'cart_full' } });
    expect(addLine(full, 'var_0', 1, newId).ok).toBe(true);
  });

  it('sets quantities and removes lines by id', () => {
    expect(setLineQuantity(lines, 'line_1', 7)).toMatchObject({ ok: true, value: [{ quantity: 7 }] });
    expect(setLineQuantity(lines, 'line_x', 7)).toMatchObject({ ok: false, error: { code: 'line_not_found' } });
    expect(setLineQuantity(lines, 'line_1', 0)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(removeLine(lines, 'line_1')).toEqual({ ok: true, value: [] });
    expect(removeLine(lines, 'line_x')).toMatchObject({ ok: false, error: { code: 'line_not_found' } });
  });
});

describe('priceLines', () => {
  const previous = line('line_1', 'var_a', 2, 1000);

  it('refreshes snapshots and prices of available lines', () => {
    const result = priceLines([{ id: 'line_1', variantId: 'var_a', quantity: 3, previous }], sellable('var_a'), priced({ var_a: 900 }));
    expect(result).toEqual({
      ok: true,
      value: [
        {
          ...previous,
          quantity: 3,
          productHandle: 'tee-new',
          productTitle: 'T-shirt v2',
          variantTitle: 'var_a!',
          sku: 'SKU',
          unitPrice: eur(900),
        },
      ],
    });
  });

  it('keeps an existing line that can no longer be sold or priced, marked unavailable', () => {
    for (const [s, p] of [
      [sellable(), priced({ var_a: 900 })],
      [sellable('var_a'), priced({})],
    ] as const) {
      expect(priceLines([{ id: 'line_1', variantId: 'var_a', quantity: 2, previous }], s, p)).toEqual({
        ok: true,
        value: [{ ...previous, available: false }],
      });
    }
  });

  it('refuses a new line that is not for sale or has no price', () => {
    const fresh = [{ id: 'line_2', variantId: 'var_b', quantity: 1 }];
    expect(priceLines(fresh, sellable(), priced({ var_b: 1 }))).toMatchObject({ ok: false, error: { code: 'variant_not_available' } });
    expect(priceLines(fresh, sellable('var_b'), priced({}))).toMatchObject({ ok: false, error: { code: 'variant_not_priced' } });
  });
});

describe('cartTotals', () => {
  it('totals available lines only, through the adjusters', () => {
    const fee: Adjuster = {
      id: 'fee',
      priority: 0,
      adjust: () => [{ kind: 'fee', label: 'Fee', amount: eur(100), target: { type: 'order' } }],
    };
    const totals = cartTotals('EUR', [line('l1', 'a', 2, 1000), line('l2', 'b', 1, 500, false)], [fee]);
    expect(totals.subtotal).toEqual(eur(2000));
    expect(totals.total).toEqual(eur(2100));
    expect(totals.lines.map((l) => l.lineId)).toEqual(['l1']);
  });
});
