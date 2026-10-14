import type { AstroCookies } from 'astro';
import { CART_COOKIE } from './cart.js';
import type { PriceChange } from './checkout.js';
import { safeReturnPath, withParams } from './shopper.js';

/**
 * Shared by the cart endpoints. Each one is a form post that redirects back (303), so cart
 * changes work without JavaScript; the drawer script posts the same forms with `return` set to
 * the drawer fragment.
 */

/** The shopper's last order. Its id grants access to it, so, like the cart's, it stays HTTP-only. */
export const ORDER_COOKIE = 'order';
/** What changed when a review was re-priced (3d), shown once. */
const PRICE_CHANGES_COOKIE = 'price_changes';

const cookieOptions = (url: URL, maxAge: number) => ({
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: url.protocol === 'https:',
  maxAge,
});

export function rememberCart(cookies: AstroCookies, cartId: string, url: URL): void {
  cookies.set(CART_COOKIE, cartId, cookieOptions(url, 60 * 60 * 24 * 30));
}

/** The cart became an order: forget the cart, remember the order for the confirmation page. */
export function cartPlaced(cookies: AstroCookies, orderId: string, url: URL): void {
  cookies.delete(CART_COOKIE, { path: '/' });
  cookies.set(ORDER_COOKIE, orderId, cookieOptions(url, 60 * 60 * 24 * 30));
}

export function savePriceChanges(cookies: AstroCookies, changes: readonly PriceChange[], url: URL): void {
  cookies.set(PRICE_CHANGES_COOKIE, JSON.stringify(changes), cookieOptions(url, 60 * 10));
}

/** The saved price changes, cleared once read. */
export function takePriceChanges(cookies: AstroCookies): PriceChange[] {
  const saved = cookies.get(PRICE_CHANGES_COOKIE)?.value;
  if (saved === undefined) return [];
  cookies.delete(PRICE_CHANGES_COOKIE, { path: '/' });
  try {
    const parsed: unknown = JSON.parse(saved);
    return Array.isArray(parsed) ? (parsed as PriceChange[]) : [];
  } catch {
    return [];
  }
}

/** Where to go after a cart change, with what happened as query parameters. */
export function afterCartChange(form: FormData, outcome: Readonly<Record<string, string>>): string {
  const back = form.get('return');
  return withParams(typeof back === 'string' ? safeReturnPath(back) : '/cart', outcome);
}

/** A quantity from a form, or null when it is not a whole number. */
export function formQuantity(form: FormData, name = 'quantity'): number | null {
  const value = Number(form.get(name));
  return Number.isInteger(value) ? value : null;
}
