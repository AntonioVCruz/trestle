import { describe, expect, it } from 'vitest';
import { allocate, money, sum } from './money.js';
import { computeTotals, type Adjuster, type TotalsInput } from './totals.js';

const eur = (amount: number) => money(amount, 'EUR');

const input: TotalsInput = {
  currency: 'EUR',
  lines: [
    { id: 'l1', unitPrice: eur(3000), quantity: 1 },
    { id: 'l2', unitPrice: eur(500), quantity: 2 },
  ],
};

/** 10% off the order, prorated across lines. */
const tenPercentOff: Adjuster = {
  id: 'promo.ten-off',
  priority: 300,
  adjust: ({ input, lineSubtotals, subtotal }) => {
    const discount = eur(-Math.round(subtotal.amount / 10));
    const shares = allocate(
      discount,
      input.lines.map((l) => lineSubtotals.get(l.id)!.amount),
    );
    return input.lines.map((line, i) => ({
      kind: 'promotion',
      label: '10% off',
      amount: shares[i]!,
      target: { type: 'line' as const, lineId: line.id },
    }));
  },
};

const flatShipping: Adjuster = {
  id: 'shipping.flat',
  priority: 200,
  adjust: () => [{ kind: 'shipping', label: 'Flat rate', amount: eur(495), target: { type: 'order' } }],
};

/** 20% tax on each discounted line; runs after promotions because of its lower priority. */
const lineTax: Adjuster = {
  id: 'tax.flat-20',
  priority: 100,
  adjust: ({ input, lineSubtotals, adjustments }) =>
    input.lines.map((line) => {
      const discounts = sum(
        adjustments
          .filter((a) => a.kind === 'promotion' && a.target.type === 'line' && a.target.lineId === line.id)
          .map((a) => a.amount),
        'EUR',
      );
      const taxable = lineSubtotals.get(line.id)!.amount + discounts.amount;
      return {
        kind: 'tax',
        label: 'VAT 20%',
        amount: eur(Math.round(taxable * 0.2)),
        target: { type: 'line' as const, lineId: line.id },
      };
    }),
};

describe('computeTotals', () => {
  it('runs adjusters by priority regardless of registration order', () => {
    const totals = computeTotals(input, [lineTax, flatShipping, tenPercentOff]);

    expect(totals.subtotal).toEqual(eur(4000));
    expect(totals.adjustments.map((a) => a.source)).toEqual([
      'promo.ten-off',
      'promo.ten-off',
      'shipping.flat',
      'tax.flat-20',
      'tax.flat-20',
    ]);
    // 4000 - 400 discount + 495 shipping + 720 tax (20% of 3600)
    expect(totals.total).toEqual(eur(4815));
    expect(totals.lines).toEqual([
      { lineId: 'l1', subtotal: eur(3000), adjustmentsTotal: eur(-300 + 540), total: eur(3240) },
      { lineId: 'l2', subtotal: eur(1000), adjustmentsTotal: eur(-100 + 180), total: eur(1080) },
    ]);
  });

  it('reports neutral (price-inclusive) adjustments without adding them', () => {
    const includedVat: Adjuster = {
      id: 'tax.included',
      priority: 0,
      adjust: () => [{ kind: 'tax', label: 'incl. VAT', amount: eur(667), target: { type: 'order' }, neutral: true }],
    };
    const totals = computeTotals(input, [includedVat]);
    expect(totals.total).toEqual(eur(4000));
    expect(totals.adjustments).toHaveLength(1);
  });

  it('rejects adjustments in another currency or for unknown lines', () => {
    const usd: Adjuster = {
      id: 'bad.usd',
      priority: 0,
      adjust: () => [{ kind: 'fee', label: 'x', amount: money(1, 'USD'), target: { type: 'order' } }],
    };
    const ghost: Adjuster = {
      id: 'bad.ghost',
      priority: 0,
      adjust: () => [{ kind: 'fee', label: 'x', amount: eur(1), target: { type: 'line', lineId: 'nope' } }],
    };
    expect(() => computeTotals(input, [usd])).toThrow(/Currency mismatch/);
    expect(() => computeTotals(input, [ghost])).toThrow(/unknown line/);
  });

  it('fails loudly when adjusters push the total below zero', () => {
    const tooGenerous: Adjuster = {
      id: 'promo.too-generous',
      priority: 0,
      adjust: () => [{ kind: 'promotion', label: 'x', amount: eur(-5000), target: { type: 'order' } }],
    };
    expect(() => computeTotals(input, [tooGenerous])).toThrow(/negative total/);
  });
});
