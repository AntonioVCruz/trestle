import type { Money } from '../../kernel/money.js';
import { err, ok, type DomainError, type Result } from '../../kernel/result.js';
import { computeTotals, type Adjuster, type Totals } from '../../kernel/totals.js';

export const MAX_LINE_QUANTITY = 1000;
export const MAX_LINES = 100;

/** What a line shows about its variant, copied when the line is priced. */
export interface LineSnapshot {
  readonly productId: string;
  readonly productHandle: string;
  readonly productTitle: string;
  readonly variantTitle: string;
  readonly sku: string | null;
}

/** A variant the catalog will sell in the cart's channel right now. */
export interface SellableVariant extends LineSnapshot {
  readonly variantId: string;
}

export interface LinePrice {
  readonly unitPrice: Money;
  /** The regular price a sale undercuts, for "was" displays. */
  readonly originalUnitPrice: Money | null;
}

export interface CartLineState extends LineSnapshot, LinePrice {
  readonly id: string;
  readonly variantId: string;
  readonly quantity: number;
  /** False when the variant can no longer be sold or priced; such lines are left out of totals. */
  readonly available: boolean;
}

/** A line as a cart operation wants it: existing lines carry their last priced state. */
export interface DesiredLine {
  readonly id: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly previous?: CartLineState;
}

export type InvalidInput = DomainError<'invalid_input'>;
export type LineOperationError = DomainError<'invalid_input' | 'line_not_found' | 'cart_full'>;

export function checkQuantity(quantity: number): Result<void, InvalidInput> {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
    return err('invalid_input', `Quantity must be an integer from 1 to ${MAX_LINE_QUANTITY}`);
  }
  return ok(undefined);
}

const desired = (line: CartLineState, quantity = line.quantity): DesiredLine => ({
  id: line.id,
  variantId: line.variantId,
  quantity,
  previous: line,
});

/** Adding a variant already in the cart raises that line's quantity instead of adding a line. */
export function addLine(
  lines: readonly CartLineState[],
  variantId: string,
  quantity: number,
  newLineId: () => string,
): Result<DesiredLine[], LineOperationError> {
  const checked = checkQuantity(quantity);
  if (!checked.ok) return checked;

  const existing = lines.find((l) => l.variantId === variantId);
  if (existing) {
    const total = existing.quantity + quantity;
    const raised = checkQuantity(total);
    if (!raised.ok) return err('invalid_input', `A line can hold at most ${MAX_LINE_QUANTITY} units`);
    return ok(lines.map((l) => (l === existing ? desired(l, total) : desired(l))));
  }
  if (lines.length >= MAX_LINES) return err('cart_full', `A cart can hold at most ${MAX_LINES} lines`);
  return ok([...lines.map((l) => desired(l)), { id: newLineId(), variantId, quantity }]);
}

export function setLineQuantity(
  lines: readonly CartLineState[],
  lineId: string,
  quantity: number,
): Result<DesiredLine[], LineOperationError> {
  if (!lines.some((l) => l.id === lineId)) return err('line_not_found', `Line "${lineId}" not found`);
  const checked = checkQuantity(quantity);
  if (!checked.ok) return checked;
  return ok(lines.map((l) => (l.id === lineId ? desired(l, quantity) : desired(l))));
}

export function removeLine(lines: readonly CartLineState[], lineId: string): Result<DesiredLine[], LineOperationError> {
  if (!lines.some((l) => l.id === lineId)) return err('line_not_found', `Line "${lineId}" not found`);
  return ok(lines.filter((l) => l.id !== lineId).map((l) => desired(l)));
}

export type PricingError = DomainError<'variant_not_available' | 'variant_not_priced'>;

/**
 * Refreshes every line from the catalog and pricing. A line that was already in the cart and can
 * no longer be sold or priced is kept but marked unavailable, so the shopper sees why. A new line
 * must be available, or the operation fails.
 */
export function priceLines(
  lines: readonly DesiredLine[],
  sellable: ReadonlyMap<string, SellableVariant>,
  prices: ReadonlyMap<string, LinePrice>,
): Result<CartLineState[], PricingError> {
  const priced: CartLineState[] = [];
  for (const line of lines) {
    const variant = sellable.get(line.variantId);
    const price = prices.get(line.variantId);
    if (variant && price) {
      const { variantId: _, ...snapshot } = variant;
      priced.push({ id: line.id, variantId: line.variantId, quantity: line.quantity, ...snapshot, ...price, available: true });
    } else if (line.previous) {
      priced.push({ ...line.previous, quantity: line.quantity, available: false });
    } else if (!variant) {
      return err('variant_not_available', `Variant "${line.variantId}" is not for sale in this channel`);
    } else {
      return err('variant_not_priced', `Variant "${line.variantId}" has no price in this cart's currency`);
    }
  }
  return ok(priced);
}

/** Totals over the available lines, through the adjuster pipeline (ADR 0006). */
export function cartTotals(currency: string, lines: readonly CartLineState[], adjusters: readonly Adjuster[]): Totals {
  return computeTotals(
    {
      currency,
      lines: lines.filter((l) => l.available).map((l) => ({ id: l.id, unitPrice: l.unitPrice, quantity: l.quantity })),
    },
    adjusters,
  );
}
