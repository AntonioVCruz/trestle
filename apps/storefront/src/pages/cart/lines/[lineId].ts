import type { APIRoute } from 'astro';
import { afterCartChange, formQuantity } from '../../../lib/cart-session.js';
import { removeCartLine, updateCartLine } from '../../../lib/store-api.js';

/**
 * Change a line's quantity, or remove it with `remove`. HTML forms cannot send PATCH or DELETE,
 * so both are posts here; the storefront maps them onto the Store API.
 */
export const POST: APIRoute = async ({ request, params, locals, redirect }) => {
  const form = await request.formData();
  const lineId = params.lineId!;
  const cart = locals.cart;
  if (!cart) return redirect(afterCartChange(form, { error: 'line_not_found' }), 303);

  if (form.has('remove')) {
    const result = await removeCartLine(cart.id, lineId);
    return redirect(afterCartChange(form, result.ok ? { removed: '1' } : { error: result.code }), 303);
  }
  const quantity = formQuantity(form);
  if (quantity === null) return redirect(afterCartChange(form, { error: 'invalid_input' }), 303);
  const result = await updateCartLine(cart.id, lineId, quantity);
  return redirect(afterCartChange(form, result.ok ? { updated: lineId } : { error: result.code }), 303);
};
