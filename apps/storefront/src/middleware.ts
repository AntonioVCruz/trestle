import { defineMiddleware } from 'astro:middleware';
import { CART_COOKIE, shopCurrency } from './lib/cart.js';
import { cartPlaced } from './lib/cart-session.js';
import { buildCategoryTree } from './lib/categories.js';
import { CURRENCY_COOKIE, chooseCurrency } from './lib/shopper.js';
import { getCart, storeApi } from './lib/store-api.js';

/**
 * Every page needs the channel (name, currencies), the category tree for navigation, and the
 * shopper's cart for the header count and the currency lock.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  // Health checks answer for themselves; they must work when the Store API doesn't.
  if (context.url.pathname.startsWith('/health/')) return next();

  const cartId = context.cookies.get(CART_COOKIE)?.value;
  const [channel, categories, cart] = await Promise.all([
    storeApi.GET('/store/v1/channel'),
    storeApi.GET('/store/v1/categories'),
    cartId ? getCart(cartId) : null,
  ]);
  if (!channel.data || !categories.data) {
    // Thrown, so Astro renders the 500 page; a wrong key or a stopped API both land here.
    const error = channel.error ?? categories.error;
    throw new Error(`Store API unavailable: ${error ? `${error.error.code}: ${error.error.message}` : 'no response'}`);
  }

  // A cart that became an order is swapped for the order, which the confirmation page reads;
  // that is also how a shopper waiting on 3e learns the order went through. An unknown cart is
  // forgotten. Either way, the next add starts a new cart.
  const liveCart = cart && cart.checkoutState !== 'placed' ? cart : null;
  if (cart?.checkoutState === 'placed' && cart.orderId) cartPlaced(context.cookies, cart.orderId, context.url);
  else if (cartId && !liveCart) context.cookies.delete(CART_COOKIE, { path: '/' });

  const chosen = chooseCurrency(channel.data, context.cookies.get(CURRENCY_COOKIE)?.value);
  Object.assign(context.locals, {
    channel: channel.data,
    categories: buildCategoryTree(categories.data.data),
    cart: liveCart,
    currency: shopCurrency(liveCart, chosen),
    locale: channel.data.defaultLocale,
  } satisfies App.Locals);
  return next();
});
