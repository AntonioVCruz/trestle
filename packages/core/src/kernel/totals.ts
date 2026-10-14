import { add, assertCurrency, money, sum, type CurrencyCode, type Money } from './money.js';

/**
 * The totals pipeline (ADR 0006): ordered, pure adjusters each look at the cart plus every
 * adjustment produced so far and return new adjustments. Nothing mutates prices in place,
 * so every cent of the total is traceable to the adjuster that produced it.
 */

export type AdjustmentTarget = { readonly type: 'order' } | { readonly type: 'line'; readonly lineId: string };

export interface AdjustmentDraft {
  /** e.g. "promotion", "shipping", "tax". Open-ended so extensions can add kinds. */
  readonly kind: string;
  readonly label: string;
  /** Signed: discounts are negative, charges positive. */
  readonly amount: Money;
  readonly target: AdjustmentTarget;
  /** Already contained in the price (e.g. VAT in tax-inclusive prices): reported, not added. */
  readonly neutral?: boolean;
}

export interface Adjustment extends AdjustmentDraft {
  /** Id of the adjuster that produced it. */
  readonly source: string;
}

export interface TotalsLine {
  readonly id: string;
  readonly unitPrice: Money;
  readonly quantity: number;
}

export interface TotalsInput {
  readonly currency: CurrencyCode;
  readonly lines: readonly TotalsLine[];
}

export interface TotalsState {
  readonly input: TotalsInput;
  readonly lineSubtotals: ReadonlyMap<string, Money>;
  readonly subtotal: Money;
  readonly adjustments: readonly Adjustment[];
}

export interface Adjuster {
  readonly id: string;
  /** Higher runs first; ties are broken by id so the order is always deterministic. */
  readonly priority: number;
  adjust(state: TotalsState): readonly AdjustmentDraft[];
}

export interface LineTotals {
  readonly lineId: string;
  readonly subtotal: Money;
  readonly adjustmentsTotal: Money;
  readonly total: Money;
}

export interface Totals {
  readonly subtotal: Money;
  readonly adjustments: readonly Adjustment[];
  readonly adjustmentsTotal: Money;
  readonly total: Money;
  readonly lines: readonly LineTotals[];
}

export function computeTotals(input: TotalsInput, adjusters: readonly Adjuster[]): Totals {
  const { currency } = input;
  const lineSubtotals = new Map<string, Money>();
  for (const line of input.lines) {
    if (lineSubtotals.has(line.id)) throw new Error(`Duplicate line id "${line.id}"`);
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new RangeError(`Line "${line.id}" quantity must be a positive integer`);
    }
    assertCurrency(line.unitPrice, currency);
    lineSubtotals.set(line.id, money(line.unitPrice.amount * line.quantity, currency));
  }
  const subtotal = sum([...lineSubtotals.values()], currency);

  const ordered = [...adjusters].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let adjustments: readonly Adjustment[] = [];
  for (const adjuster of ordered) {
    const produced = adjuster.adjust({ input, lineSubtotals, subtotal, adjustments });
    for (const draft of produced) {
      assertCurrency(draft.amount, currency);
      if (draft.target.type === 'line' && !lineSubtotals.has(draft.target.lineId)) {
        throw new Error(`Adjuster "${adjuster.id}" targeted unknown line "${draft.target.lineId}"`);
      }
    }
    adjustments = [...adjustments, ...produced.map((draft) => ({ ...draft, source: adjuster.id }))];
  }

  const counted = adjustments.filter((a) => !a.neutral);
  const adjustmentsTotal = sum(
    counted.map((a) => a.amount),
    currency,
  );
  const total = add(subtotal, adjustmentsTotal);
  if (total.amount < 0) {
    throw new RangeError(`Adjusters produced a negative total (${total.amount} ${currency})`);
  }

  const lines = [...lineSubtotals].map(([lineId, lineSubtotal]) => {
    const lineAdjustments = sum(
      counted.filter((a) => a.target.type === 'line' && a.target.lineId === lineId).map((a) => a.amount),
      currency,
    );
    return { lineId, subtotal: lineSubtotal, adjustmentsTotal: lineAdjustments, total: add(lineSubtotal, lineAdjustments) };
  });

  return { subtotal, adjustments, adjustmentsTotal, total, lines };
}
