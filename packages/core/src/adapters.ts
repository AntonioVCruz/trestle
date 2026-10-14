import { err, ok } from './kernel/result.js';
import type {
  CartCatalog,
  CartPayments,
  CartPricing,
  CartService,
  CartShipping,
  LinePrice,
  SellableVariant,
} from './modules/cart/index.js';
import type { CatalogService } from './modules/catalog/index.js';
import type { CompletionCarts, CompletionOrders, CompletionPayments } from './modules/checkout/index.js';
import type { OrderService } from './modules/orders/index.js';
import type { PaymentsService } from './modules/payments/index.js';
import type { PricingService } from './modules/pricing/index.js';
import type { ShippingService } from './modules/shipping/index.js';

/**
 * Adapters from one module's service to the interfaces another module declares it needs
 * (ADR 0002). Only composition code knows both sides; the modules know only their own types.
 */

/** A variant is sellable in a channel when its product is published and listed there. */
export function cartCatalog(catalog: Pick<CatalogService, 'getVariants' | 'getProducts'>): CartCatalog {
  return {
    async sellableVariants(variantIds, channelId) {
      const sellable = new Map<string, SellableVariant>();
      const variants = await catalog.getVariants([...new Set(variantIds)]);
      if (variants.length === 0) return sellable;
      const products = new Map((await catalog.getProducts([...new Set(variants.map((v) => v.productId))])).map((p) => [p.id, p]));

      for (const variant of variants) {
        const product = products.get(variant.productId);
        if (!product || product.status !== 'published' || !product.channelIds.includes(channelId)) continue;
        sellable.set(variant.id, {
          variantId: variant.id,
          productId: product.id,
          productHandle: product.handle,
          productTitle: product.title,
          variantTitle: variant.title,
          sku: variant.sku,
        });
      }
      return sellable;
    },
  };
}

/** Lines are priced at their own quantity, so tier prices apply; one lookup per distinct quantity. */
export function cartPricing(pricing: Pick<PricingService, 'resolvePrices'>): CartPricing {
  return {
    async unitPrices(lines, { currency, channelId, at }) {
      const byQuantity = new Map<number, string[]>();
      for (const { variantId, quantity } of lines) byQuantity.set(quantity, [...(byQuantity.get(quantity) ?? []), variantId]);

      const prices = new Map<string, LinePrice>();
      await Promise.all(
        [...byQuantity].map(async ([quantity, variantIds]) => {
          const resolved = await pricing.resolvePrices(variantIds, { currency, channelId, quantity, at });
          for (const [variantId, price] of resolved) {
            prices.set(variantId, { unitPrice: price.amount, originalUnitPrice: price.original });
          }
        }),
      );
      return prices;
    },
  };
}

export function cartShipping(shipping: Pick<ShippingService, 'quotes'>): CartShipping {
  return { quotes: (context) => shipping.quotes(context) };
}

export function cartPayments(payments: Pick<PaymentsService, 'availableMethods' | 'startSession'>): CartPayments {
  return {
    methods: (channelId) => payments.availableMethods(channelId),
    async startSession(request) {
      const session = await payments.startSession(request);
      if (!session.ok) return session;
      const { id, providerId, providerName, amount, clientData } = session.value;
      return ok({ sessionId: id, providerId, name: providerName, amount, clientData });
    },
  };
}

export function completionCarts(carts: CartService): CompletionCarts {
  // The cart service already speaks the completion interface; this pins that down.
  return carts;
}

export function completionPayments(
  payments: Pick<PaymentsService, 'authorizeSession' | 'cancelAuthorization' | 'captureSession' | 'sessionsAwaitingCapture'>,
): CompletionPayments {
  return {
    async authorize(input) {
      const session = await payments.authorizeSession(input);
      return session.ok ? ok({ captureMode: session.value.captureMode }) : session;
    },
    cancel: (sessionId, idempotencyKey) => payments.cancelAuthorization(sessionId, idempotencyKey),
    capture: (sessionId, idempotencyKey) => payments.captureSession({ sessionId, idempotencyKey }),
    async awaitingCapture(lastChangedBefore) {
      return (await payments.sessionsAwaitingCapture(lastChangedBefore)).map((s) => ({ sessionId: s.id, cartId: s.cartId }));
    },
  };
}

export function completionOrders(orders: Pick<OrderService, 'placeOrder' | 'getOrderByCart'>): CompletionOrders {
  return {
    async placeOrder(cart) {
      const { email, shippingAddress, billingAddress, shippingMethod, paymentMethod } = cart;
      if (!email || !shippingAddress || !billingAddress || !shippingMethod || !paymentMethod) {
        return err('invalid_input', 'The cart is missing checkout details');
      }
      return orders.placeOrder({
        cartId: cart.id,
        channelId: cart.channelId,
        currency: cart.currency,
        email,
        shippingAddress,
        billingAddress,
        shippingMethod,
        lines: cart.lines.map(({ id, ...line }) => ({ ...line, cartLineId: id })),
        subtotal: cart.subtotal,
        adjustments: cart.adjustments,
        adjustmentsTotal: cart.adjustmentsTotal,
        total: cart.total,
        payment: { providerId: paymentMethod.providerId, sessionId: paymentMethod.sessionId },
      });
    },
    async getOrderByCart(cartId) {
      const order = await orders.getOrderByCart(cartId);
      return order && { id: order.id, paymentSessionId: order.payment.sessionId };
    },
  };
}
