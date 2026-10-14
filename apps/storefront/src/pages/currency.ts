import type { APIRoute } from 'astro';
import { isCurrencyLocked } from '../lib/cart.js';
import { CURRENCY_COOKIE, safeReturnPath } from '../lib/shopper.js';

/**
 * The currency picker posts here; the choice is remembered in a cookie (wireframe 2b). It is
 * refused while the cart holds anything, since a cart's currency is fixed. Astro's origin check
 * rejects cross-site posts.
 */
export const POST: APIRoute = async ({ request, locals, cookies, redirect }) => {
  const form = await request.formData();
  const currency = form.get('currency');
  if (!isCurrencyLocked(locals.cart) && typeof currency === 'string' && locals.channel.currencies.includes(currency)) {
    cookies.set(CURRENCY_COOKIE, currency, { path: '/', sameSite: 'lax', httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
  }
  return redirect(safeReturnPath(form.get('return')), 303);
};
