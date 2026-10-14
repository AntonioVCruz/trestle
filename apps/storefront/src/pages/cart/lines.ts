import type { APIRoute } from 'astro';
import { needsNewCart } from '../../lib/cart.js';
import { afterCartChange, formQuantity, rememberCart } from '../../lib/cart-session.js';
import { addCartLine, createCart } from '../../lib/store-api.js';

/**
 * Add to cart (1h). Creates the cart on the first add, in the shopper's currency (2b), then adds
 * the line; adding a variant that is already in the cart raises its quantity.
 */
export const POST: APIRoute = async ({ request, locals, cookies, url, redirect }) => {
  const form = await request.formData();
  const variantId = form.get('variantId');
  const quantity = formQuantity(form);
  if (typeof variantId !== 'string' || variantId === '' || quantity === null) {
    return redirect(afterCartChange(form, { error: 'invalid_input' }), 303);
  }

  const startCart = async () => {
    const cart = await createCart(locals.currency);
    rememberCart(cookies, cart.id, url);
    return cart.id;
  };

  let cartId = needsNewCart(locals.cart, locals.currency) ? await startCart() : locals.cart!.id;
  let result = await addCartLine(cartId, variantId, quantity);
  if (!result.ok && result.code === 'cart_not_found') {
    // Expired between loading the page and posting: start over once.
    cartId = await startCart();
    result = await addCartLine(cartId, variantId, quantity);
  }
  if (!result.ok) return redirect(afterCartChange(form, { error: result.code }), 303);

  const line = result.cart.lines.find((l) => l.variantId === variantId);
  return redirect(afterCartChange(form, line ? { added: line.id } : {}), 303);
};
