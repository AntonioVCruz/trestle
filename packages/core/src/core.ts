import {
  cartCatalog,
  cartPayments,
  cartPricing,
  cartShipping,
  completionCarts,
  completionOrders,
  completionPayments,
} from './adapters.js';
import type { CoreDatabase } from './kernel/db.js';
import type { MigrationSource } from './kernel/module.js';
import { kernelMigrations } from './kernel/outbox.js';
import { cartModule, type CartService } from './modules/cart/index.js';
import { catalogModule, type CatalogService } from './modules/catalog/index.js';
import { channelModule, type ChannelService } from './modules/channel/index.js';
import { checkoutModule, type CheckoutService } from './modules/checkout/index.js';
import { ordersModule, type OrderService } from './modules/orders/index.js';
import { paymentsModule, type PaymentProvider, type PaymentsService } from './modules/payments/index.js';
import { pricingModule, type PricingService } from './modules/pricing/index.js';
import { shippingModule, type ShippingService } from './modules/shipping/index.js';

/** Composition root: the only place that knows every module. */

/** Applied in this order. Modules never reference each other's tables, so order only matters for the kernel. */
export const migrationSources: readonly MigrationSource[] = [
  kernelMigrations,
  channelModule,
  catalogModule,
  pricingModule,
  shippingModule,
  paymentsModule,
  cartModule,
  ordersModule,
  checkoutModule,
];

export interface Core {
  readonly channel: ChannelService;
  readonly catalog: CatalogService;
  readonly pricing: PricingService;
  readonly shipping: ShippingService;
  readonly payments: PaymentsService;
  readonly cart: CartService;
  readonly orders: OrderService;
  readonly checkout: CheckoutService;
}

export interface CoreOptions {
  /**
   * Payment providers to register (ADR 0017). Merchants then enable them per channel; a
   * registered provider is offered nowhere until they do.
   */
  readonly paymentProviders?: readonly PaymentProvider[];
}

export function createCore(db: CoreDatabase, options: CoreOptions = {}): Core {
  const catalog = catalogModule.createService(db);
  const pricing = pricingModule.createService(db);
  const shipping = shippingModule.createService(db);
  const payments = paymentsModule.createService(db, { providers: options.paymentProviders ?? [] });
  const orders = ordersModule.createService(db);
  const cart = cartModule.createService(db, {
    catalog: cartCatalog(catalog),
    pricing: cartPricing(pricing),
    shipping: cartShipping(shipping),
    payments: cartPayments(payments),
    // No promotion or tax modules yet; they will register adjusters here.
    adjusters: [],
  });
  return {
    channel: channelModule.createService(db),
    catalog,
    pricing,
    shipping,
    payments,
    cart,
    orders,
    checkout: checkoutModule.createService(db, {
      carts: completionCarts(cart),
      payments: completionPayments(payments),
      orders: completionOrders(orders),
    }),
  };
}
