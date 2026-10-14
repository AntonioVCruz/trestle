import type { AstroCookies } from 'astro';
import { cartPlaced, savePriceChanges } from './cart-session.js';
import { afterCompletionError, checkoutBlock, priceChanges, reachableStep, stepIndex, type Step } from './checkout.js';
import { placeWithRetries } from './completion.js';
import { completeCart, getCart } from './store-api.js';
import type { Cart } from './types.js';

/**
 * Where a checkout page must send the shopper instead of rendering, if anywhere: back to the
 * cart when checkout can't start (3b), to 3e while an order is being placed, or to the furthest
 * step the cart has reached when a later one was asked for.
 */
export function checkoutRedirect(cart: Cart | null, step: Step): string | null {
  switch (checkoutBlock(cart)) {
    case 'no_cart':
      return '/cart';
    case 'unavailable_lines':
      return '/cart?error=cart_not_ready';
    case 'completing':
      return '/checkout/placing';
  }
  const reachable = reachableStep(cart!);
  return stepIndex(step) > stepIndex(reachable) ? `/checkout/${reachable}` : null;
}

/** How long the server keeps retrying before showing 3e and polling instead. */
const PLACE_ORDER_DEADLINE_MS = 20_000;

/**
 * Places the order and says where to go next: the confirmation, 3e if it is still running, or
 * the screen for whatever went wrong. `before` is the cart the shopper reviewed, to explain a
 * re-pricing (3d).
 */
export async function placeOrder(before: Cart, idempotencyKey: string, cookies: AstroCookies, url: URL): Promise<string> {
  const result = await placeWithRetries(() => completeCart(before.id, idempotencyKey), { deadlineMs: PLACE_ORDER_DEADLINE_MS });
  if (result.kind === 'placed') {
    cartPlaced(cookies, result.order.id, url);
    return '/checkout/confirmation';
  }
  if (result.kind === 'pending') return '/checkout/placing';
  if (result.code === 'cart_changed') {
    const after = await getCart(before.id);
    if (after) savePriceChanges(cookies, priceChanges(before, after), url);
  }
  return afterCompletionError(result.code);
}
