import { createStoreClient } from '@trestle/sdk';
import { TRESTLE_API_URL, TRESTLE_PUBLISHABLE_KEY } from 'astro:env/server';
import type { AddressesInput } from './checkout.js';
import type { CompletionAttempt } from './completion.js';
import type { Cart, Order, PaymentMethod, ShippingQuote } from './types.js';

/**
 * The storefront's only way into the platform: the Store API over HTTP (ADR 0003). Calls are
 * made on the server, so the browser talks only to the storefront (ADR 0020).
 */
export const storeApi = createStoreClient({ baseUrl: TRESTLE_API_URL, publishableKey: TRESTLE_PUBLISHABLE_KEY });

/** A cart change either returns the updated cart or the Store API's error code. */
export type CartChange = { readonly ok: true; readonly cart: Cart } | { readonly ok: false; readonly code: string };

function cartChange(result: { data?: Cart; error?: { error: { code: string } } }): CartChange {
  return result.data ? { ok: true, cart: result.data } : { ok: false, code: result.error?.error.code ?? 'unknown' };
}

/** The cart, or null when the id is unknown (expired, or from another installation). */
export async function getCart(id: string): Promise<Cart | null> {
  const { data, error, response } = await storeApi.GET('/store/v1/carts/{id}', { params: { path: { id } } });
  if (data) return data;
  if (response.status === 404) return null;
  throw new Error(`Loading the cart failed: ${error?.error.code}: ${error?.error.message}`);
}

export async function createCart(currency: string): Promise<Cart> {
  const { data, error } = await storeApi.POST('/store/v1/carts', { body: { currency } });
  if (!data) throw new Error(`Creating a cart failed: ${error.error.code}: ${error.error.message}`);
  return data;
}

export async function addCartLine(cartId: string, variantId: string, quantity: number): Promise<CartChange> {
  return cartChange(await storeApi.POST('/store/v1/carts/{id}/lines', { params: { path: { id: cartId } }, body: { variantId, quantity } }));
}

export async function updateCartLine(cartId: string, lineId: string, quantity: number): Promise<CartChange> {
  return cartChange(await storeApi.PATCH('/store/v1/carts/{id}/lines/{lineId}', { params: { path: { id: cartId, lineId } }, body: { quantity } }));
}

export async function removeCartLine(cartId: string, lineId: string): Promise<CartChange> {
  return cartChange(await storeApi.DELETE('/store/v1/carts/{id}/lines/{lineId}', { params: { path: { id: cartId, lineId } } }));
}

// --- Checkout (ADR 0016–0018) ---

export async function setCartAddresses(cartId: string, body: AddressesInput): Promise<CartChange> {
  return cartChange(await storeApi.POST('/store/v1/carts/{id}/addresses', { params: { path: { id: cartId } }, body }));
}

/** The cart's shipping options, cheapest first; empty when nothing ships to its address (3f). */
export async function listShippingOptions(cartId: string): Promise<ShippingQuote[]> {
  const { data, error } = await storeApi.GET('/store/v1/carts/{id}/shipping-options', { params: { path: { id: cartId } } });
  if (!data) throw new Error(`Listing shipping options failed: ${error.error.code}: ${error.error.message}`);
  return data.data;
}

export async function selectShippingMethod(cartId: string, optionId: string): Promise<CartChange> {
  return cartChange(await storeApi.POST('/store/v1/carts/{id}/shipping-method', { params: { path: { id: cartId } }, body: { optionId } }));
}

/** The channel's payment methods; empty when none is enabled (3g). */
export async function listPaymentMethods(cartId: string): Promise<PaymentMethod[]> {
  const { data, error } = await storeApi.GET('/store/v1/carts/{id}/payment-methods', { params: { path: { id: cartId } } });
  if (!data) throw new Error(`Listing payment methods failed: ${error.error.code}: ${error.error.message}`);
  return data.data;
}

export async function selectPaymentMethod(cartId: string, providerId: string, data: Record<string, unknown>): Promise<CartChange> {
  return cartChange(
    await storeApi.POST('/store/v1/carts/{id}/payment-method', { params: { path: { id: cartId } }, body: { providerId, data } }),
  );
}

/** One call to place the order. Status 0 means the request never got an answer. */
export async function completeCart(cartId: string, idempotencyKey: string): Promise<CompletionAttempt> {
  try {
    const { data, error, response } = await storeApi.POST('/store/v1/carts/{id}/complete', {
      params: { path: { id: cartId }, header: { 'idempotency-key': idempotencyKey } },
    });
    if (data) return { status: response.status, order: data };
    return { status: response.status, code: error?.error.code ?? 'unknown', details: error?.error.details ?? {} };
  } catch {
    return { status: 0, code: null, details: {} };
  }
}

/** The order, or null when the id is unknown. Its id is the shopper's key, so it stays private. */
export async function getOrder(id: string): Promise<Order | null> {
  const { data, error, response } = await storeApi.GET('/store/v1/orders/{id}', { params: { path: { id } } });
  if (data) return data;
  if (response.status === 404) return null;
  throw new Error(`Loading the order failed: ${error?.error.code}: ${error?.error.message}`);
}

export interface ListingQuery {
  readonly currency: string;
  readonly limit: number;
  readonly category?: string | undefined;
  readonly after?: string | null | undefined;
}

/** The `after` cursor was not one the Store API handed out: a stale or mangled link. */
export class InvalidCursorError extends Error {}

/** One page of a product listing, newest first. */
export async function listProducts({ currency, limit, category, after }: ListingQuery) {
  const { data, error } = await storeApi.GET('/store/v1/products', {
    params: { query: { currency, limit, ...(category ? { category } : {}), ...(after ? { after } : {}) } },
  });
  if (data) return data;
  if (error.error.code === 'invalid_cursor') throw new InvalidCursorError(error.error.message);
  throw new Error(`Listing products failed: ${error.error.code}: ${error.error.message}`);
}

export type ProductListing = Awaited<ReturnType<typeof listProducts>>;

/**
 * A listing page's products, reading the cursor from `?after=` (Load more without JavaScript).
 * Null for a cursor the API rejects; the page then sends the shopper to the listing's start.
 */
export async function loadListingPage(url: URL, query: Omit<ListingQuery, 'after'>): Promise<ProductListing | null> {
  try {
    return await listProducts({ ...query, after: url.searchParams.get('after') });
  } catch (error) {
    if (error instanceof InvalidCursorError) return null;
    throw error;
  }
}
