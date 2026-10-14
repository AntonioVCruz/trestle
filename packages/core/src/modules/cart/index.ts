import { defineModule } from '../../kernel/module.js';
import { migrations } from './migrations.js';
import { createCartService, type CartDependencies, type CartService } from './service.js';

export const cartModule = defineModule<'cart', CartService, CartDependencies>({
  name: 'cart',
  migrations,
  createService: createCartService,
});

export {
  SHIPPING_ADJUSTER_ID,
  type Address,
  type AddressesInput,
  type AddressInput,
  type SelectedPayment,
  type ShippingQuote as CartShippingQuote,
} from './checkout.js';
export {
  MAX_LINE_QUANTITY,
  MAX_LINES,
  type LinePrice,
  type LineSnapshot,
  type SellableVariant,
} from './rules.js';
export {
  CART_CREATED,
  CART_UPDATED,
  type AddLineError,
  type BeginCompletionError,
  type Cart,
  type CartCatalog,
  type CartDependencies,
  type CartLine,
  type CartPayments,
  type CartPricing,
  type CartService,
  type CartShipping,
  type CreateCartError,
  type CreateCartInput,
  type ListPaymentMethodsError,
  type ListShippingOptionsError,
  type MarkPlacedError,
  type PaymentSessionError,
  type PaymentSessionRequest,
  type RemoveLineError,
  type RepriceError,
  type SelectPaymentMethodError,
  type SelectShippingOptionError,
  type SetAddressesError,
  type ShippingContext,
  type UpdateLineError,
} from './service.js';
