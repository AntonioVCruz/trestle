import type { CartLine } from './types.js';

/** What the cart rules read: its lines and its fixed currency. */
type CartShape = { readonly lines: readonly unknown[]; readonly currency: string };

/** The cookie that holds the cart id. The id grants access to the cart, so it stays HTTP-only. */
export const CART_COOKIE = 'cart';

/**
 * The variant title a product without options gets (ADR 0013). Its lines read better as the
 * product title alone.
 */
const DEFAULT_VARIANT_TITLE = 'Default';

/** "Linen Tee — M / Red", or just "Canvas Tote". */
export function lineTitle(line: Pick<CartLine, 'productTitle' | 'variantTitle'>): string {
  return line.variantTitle === DEFAULT_VARIANT_TITLE ? line.productTitle : `${line.productTitle} — ${line.variantTitle}`;
}

/** A cart's currency is fixed at creation, so the picker locks once it holds anything (2b). */
export function isCurrencyLocked(cart: Pick<CartShape, 'lines'> | null): boolean {
  return cart !== null && cart.lines.length > 0;
}

/** The currency the shop shows prices in: the cart's while it is locked, else the shopper's pick. */
export function shopCurrency(cart: CartShape | null, chosen: string): string {
  return cart && isCurrencyLocked(cart) ? cart.currency : chosen;
}

/**
 * Whether adding to the cart must start a new one: there is none, or it is empty and in another
 * currency than the shopper has since picked (2b: "the next Add to cart creates the cart").
 */
export function needsNewCart(cart: CartShape | null, currency: string): boolean {
  return cart === null || (cart.lines.length === 0 && cart.currency !== currency);
}

/** Lines that can no longer be bought (3b). They block checkout until removed. */
export function unavailableLines<L extends Pick<CartLine, 'available'>>(cart: { readonly lines: readonly L[] }): L[] {
  return cart.lines.filter((line) => !line.available);
}

/** What to tell the shopper when a cart change fails, by Store API error code. */
export function cartErrorMessage(code: string): string {
  switch (code) {
    case 'variant_not_available':
      return 'Sorry, that item is no longer available.';
    case 'variant_not_priced':
      return 'Sorry, that item can’t be bought in this currency.';
    case 'cart_full':
      return 'Your cart is full. Remove something to add more.';
    case 'invalid_input':
    case 'invalid_request': // the Store API's schema validation, e.g. a quantity of 0
      return 'Please choose a quantity between 1 and 1000.';
    case 'line_not_found':
      return 'That item was already removed from your cart.';
    case 'cart_locked':
      return 'Your order is being placed, so the cart can’t change right now.';
    default:
      return 'Something went wrong updating your cart. Please try again.';
  }
}
