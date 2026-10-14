import { Type, type Static } from 'typebox';
import type { Cart, CartShippingQuote, Category, Channel, Order, Product, ResolvedPrice } from '@trestle/core';

export const ErrorSchema = Type.Object(
  {
    error: Type.Object({
      code: Type.String(),
      message: Type.String(),
      details: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), { description: 'Extra data for some codes, e.g. clientData' }),
      ),
    }),
  },
  { $id: 'Error' },
);
export type ErrorBody = Static<typeof ErrorSchema>;

export const errorBody = (code: string, message: string, details?: Readonly<Record<string, unknown>>): ErrorBody => ({
  error: details ? { code, message, details: { ...details } } : { code, message },
});

/** The storefront's view of a channel. Deliberately narrower than the admin's. */
export const StoreChannelSchema = Type.Object(
  {
    code: Type.String(),
    name: Type.String(),
    defaultCurrency: Type.String(),
    currencies: Type.Array(Type.String()),
    defaultLocale: Type.String(),
    locales: Type.Array(Type.String()),
  },
  { $id: 'StoreChannel' },
);
export type StoreChannel = Static<typeof StoreChannelSchema>;

export function toStoreChannel(channel: Channel): StoreChannel {
  return {
    code: channel.code,
    name: channel.name,
    defaultCurrency: channel.defaultCurrency,
    currencies: [...channel.currencies],
    defaultLocale: channel.defaultLocale,
    locales: [...channel.locales],
  };
}

const NullableString = Type.Union([Type.String(), Type.Null()]);

export const DEFAULT_PAGE_SIZE = 20;

export const StoreProductOptionSchema = Type.Object(
  { name: Type.String(), values: Type.Array(Type.String()) },
  { $id: 'StoreProductOption' },
);

export const StorePriceSchema = Type.Object(
  {
    amount: Type.Integer({ description: 'Minor units, e.g. cents' }),
    currency: Type.String(),
    originalAmount: Type.Union([Type.Integer(), Type.Null()], {
      description: 'The regular price when a sale undercuts it, for "was" displays',
    }),
  },
  { $id: 'StorePrice' },
);
export type StorePrice = Static<typeof StorePriceSchema>;

export const StoreVariantSchema = Type.Object(
  {
    id: Type.String({ description: 'Refer to this id when adding the variant to a cart' }),
    sku: NullableString,
    title: Type.String(),
    options: Type.Array(Type.Object({ name: Type.String(), value: Type.String() })),
    price: Type.Union([Type.Ref('StorePrice'), Type.Null()], {
      description: 'Unit price for a quantity of one, now; null when the variant has no price in this currency',
    }),
  },
  { $id: 'StoreVariant' },
);

/** A published product as the storefront sees it: no status, channels or timestamps. */
export const StoreProductSchema = Type.Object(
  {
    id: Type.String(),
    handle: Type.String(),
    title: Type.String(),
    description: NullableString,
    options: Type.Array(Type.Ref('StoreProductOption')),
    variants: Type.Array(Type.Ref('StoreVariant')),
    categoryIds: Type.Array(Type.String()),
  },
  { $id: 'StoreProduct' },
);
export type StoreProduct = Static<typeof StoreProductSchema>;

export const StoreProductPageSchema = Type.Object(
  {
    data: Type.Array(Type.Ref('StoreProduct')),
    nextCursor: Type.Union([Type.String(), Type.Null()], { description: 'Pass as `after` for the next page' }),
  },
  { $id: 'StoreProductPage' },
);

const currencyQuery = Type.Optional(
  Type.String({ pattern: '^[A-Z]{3}$', description: "One of the channel's currencies; defaults to its default currency" }),
);

export const GetStoreProductQuerySchema = Type.Object({ currency: currencyQuery });

export const ListStoreProductsQuerySchema = Type.Object({
  currency: currencyQuery,
  category: Type.Optional(Type.String({ description: 'Category handle' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: DEFAULT_PAGE_SIZE })),
  after: Type.Optional(Type.String({ description: '`nextCursor` from the previous page; anything else is rejected with 400 `invalid_cursor`' })),
});

export const StoreCategorySchema = Type.Object(
  {
    id: Type.String(),
    parentId: NullableString,
    handle: Type.String(),
    name: Type.String(),
    position: Type.Integer(),
  },
  { $id: 'StoreCategory' },
);
export type StoreCategory = Static<typeof StoreCategorySchema>;

export const StoreCategoryListSchema = Type.Object(
  { data: Type.Array(Type.Ref('StoreCategory')) },
  { $id: 'StoreCategoryList' },
);

/** Prices resolved by variant id; a variant missing from the map has no price. */
export function toStoreProduct(product: Product, prices: ReadonlyMap<string, ResolvedPrice>): StoreProduct {
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    description: product.description,
    options: product.options.map(({ name, values }) => ({ name, values: [...values] })),
    variants: product.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      options: v.options.map(({ name, value }) => ({ name, value })),
      price: toStorePrice(prices.get(v.id)),
    })),
    categoryIds: [...product.categoryIds],
  };
}

function toStorePrice(price: ResolvedPrice | undefined): StorePrice | null {
  if (!price) return null;
  return {
    amount: price.amount.amount,
    currency: price.amount.currency,
    originalAmount: price.original?.amount ?? null,
  };
}

export function toStoreCategory(category: Category): StoreCategory {
  return {
    id: category.id,
    parentId: category.parentId,
    handle: category.handle,
    name: category.name,
    position: category.position,
  };
}

const Amount = Type.Integer({ description: 'Minor units, in the cart currency' });

const addressFields = {
  firstName: Type.String({ minLength: 1, maxLength: 200 }),
  lastName: Type.String({ minLength: 1, maxLength: 200 }),
  company: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  line1: Type.String({ minLength: 1, maxLength: 200 }),
  line2: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  city: Type.String({ minLength: 1, maxLength: 200 }),
  postalCode: Type.String({ minLength: 1, maxLength: 200 }),
  region: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  country: Type.String({ pattern: '^[A-Z]{2}$', description: 'ISO 3166-1 alpha-2' }),
  phone: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
};

export const StoreAddressSchema = Type.Object(
  {
    ...addressFields,
    company: NullableString,
    line2: NullableString,
    region: NullableString,
    phone: NullableString,
  },
  { $id: 'StoreAddress' },
);

const NullableAddress = Type.Union([Type.Ref('StoreAddress'), Type.Null()]);

export const StoreShippingQuoteSchema = Type.Object(
  { optionId: Type.String(), name: Type.String(), amount: Amount },
  { $id: 'StoreShippingQuote' },
);

export const StoreShippingQuoteListSchema = Type.Object(
  { data: Type.Array(Type.Ref('StoreShippingQuote')) },
  { $id: 'StoreShippingQuoteList' },
);

export const SetCartAddressesSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 254 }),
    shippingAddress: Type.Object(addressFields, { additionalProperties: false }),
    billingAddress: Type.Optional(
      Type.Union([Type.Object(addressFields, { additionalProperties: false }), Type.Null()], {
        description: 'Omit to bill to the shipping address',
      }),
    ),
  },
  { $id: 'SetCartAddresses', additionalProperties: false },
);

const ProviderData = Type.Record(Type.String(), Type.Unknown(), {
  description: 'Opaque data exchanged with the payment provider',
});

export const StorePaymentMethodSchema = Type.Object(
  { providerId: Type.String(), name: Type.String() },
  { $id: 'StorePaymentMethod' },
);

export const StorePaymentMethodListSchema = Type.Object(
  { data: Type.Array(Type.Ref('StorePaymentMethod')) },
  { $id: 'StorePaymentMethodList' },
);

export const StoreSelectedPaymentSchema = Type.Object(
  {
    providerId: Type.String(),
    name: Type.String(),
    sessionId: Type.String(),
    amount: Type.Integer({ description: 'The total the payment was prepared for' }),
    clientData: ProviderData,
  },
  { $id: 'StoreSelectedPayment' },
);

export const SelectPaymentMethodSchema = Type.Object(
  {
    providerId: Type.String({ description: 'One of the cart’s payment methods' }),
    data: Type.Optional(ProviderData),
  },
  { $id: 'SelectPaymentMethod', additionalProperties: false },
);

export const SelectShippingMethodSchema = Type.Object(
  { optionId: Type.String({ description: 'One of the cart’s shipping options' }) },
  { $id: 'SelectShippingMethod', additionalProperties: false },
);

export const StoreCartLineSchema = Type.Object(
  {
    id: Type.String(),
    variantId: Type.String(),
    productId: Type.String(),
    productHandle: Type.String(),
    productTitle: Type.String(),
    variantTitle: Type.String(),
    sku: NullableString,
    quantity: Type.Integer({ minimum: 1 }),
    unitPrice: Amount,
    originalUnitPrice: Type.Union([Amount, Type.Null()], { description: 'The regular price during a sale' }),
    subtotal: Amount,
    total: Amount,
    available: Type.Boolean({
      description: 'False when the variant can no longer be bought; the line is left out of the totals',
    }),
  },
  { $id: 'StoreCartLine' },
);

export const StoreCartSchema = Type.Object(
  {
    id: Type.String({ description: 'Keep it private: anyone with the id can read and change the cart' }),
    currency: Type.String(),
    lines: Type.Array(Type.Ref('StoreCartLine')),
    subtotal: Amount,
    adjustments: Type.Array(
      Type.Object({
        kind: Type.String({ description: 'e.g. promotion, shipping, tax' }),
        label: Type.String(),
        amount: Type.Integer({ description: 'Signed minor units: discounts are negative' }),
        lineId: Type.Union([Type.String(), Type.Null()], { description: 'Null for order-level adjustments' }),
        included: Type.Boolean({ description: 'Already contained in prices (e.g. included VAT); not added to the total' }),
      }),
    ),
    total: Amount,
    itemCount: Type.Integer({ description: 'Units across available lines' }),
    checkoutState: Type.Enum(['cart', 'addressed', 'shipping_selected', 'payment_selected', 'completing', 'placed'], {
      description: 'The checkout step the cart has reached',
    }),
    email: NullableString,
    shippingAddress: NullableAddress,
    billingAddress: NullableAddress,
    shippingMethod: Type.Union([Type.Ref('StoreShippingQuote'), Type.Null()]),
    paymentMethod: Type.Union([Type.Ref('StoreSelectedPayment'), Type.Null()], {
      description: 'Dropped automatically when the cart total changes',
    }),
    orderId: Type.Union([Type.String(), Type.Null()], {
      description: 'The order the cart became, once checkoutState is placed; read it with GET /orders/{id}',
    }),
  },
  { $id: 'StoreCart' },
);
export type StoreCart = Static<typeof StoreCartSchema>;

export const CreateCartSchema = Type.Object(
  { currency: currencyQuery },
  { $id: 'CreateCart', additionalProperties: false },
);

export const AddCartLineSchema = Type.Object(
  { variantId: Type.String(), quantity: Type.Integer({ minimum: 1, maximum: 1000 }) },
  { $id: 'AddCartLine', additionalProperties: false },
);

export const UpdateCartLineSchema = Type.Object(
  { quantity: Type.Integer({ minimum: 1, maximum: 1000 }) },
  { $id: 'UpdateCartLine', additionalProperties: false },
);

export function toStoreCart(cart: Cart): StoreCart {
  return {
    id: cart.id,
    currency: cart.currency,
    lines: cart.lines.map((l) => ({
      id: l.id,
      variantId: l.variantId,
      productId: l.productId,
      productHandle: l.productHandle,
      productTitle: l.productTitle,
      variantTitle: l.variantTitle,
      sku: l.sku,
      quantity: l.quantity,
      unitPrice: l.unitPrice.amount,
      originalUnitPrice: l.originalUnitPrice?.amount ?? null,
      subtotal: l.subtotal.amount,
      total: l.total.amount,
      available: l.available,
    })),
    subtotal: cart.subtotal.amount,
    adjustments: cart.adjustments.map((a) => ({
      kind: a.kind,
      label: a.label,
      amount: a.amount.amount,
      lineId: a.target.type === 'line' ? a.target.lineId : null,
      included: a.neutral ?? false,
    })),
    total: cart.total.amount,
    itemCount: cart.lines.filter((l) => l.available).reduce((n, l) => n + l.quantity, 0),
    checkoutState: cart.checkoutState,
    email: cart.email,
    shippingAddress: cart.shippingAddress && { ...cart.shippingAddress },
    billingAddress: cart.billingAddress && { ...cart.billingAddress },
    shippingMethod: cart.shippingMethod && toStoreShippingQuote(cart.shippingMethod),
    paymentMethod: cart.paymentMethod && {
      providerId: cart.paymentMethod.providerId,
      name: cart.paymentMethod.name,
      sessionId: cart.paymentMethod.sessionId,
      amount: cart.paymentMethod.amount.amount,
      clientData: { ...cart.paymentMethod.clientData },
    },
    orderId: cart.orderId,
  };
}

export function toStoreShippingQuote(quote: CartShippingQuote): Static<typeof StoreShippingQuoteSchema> {
  return { optionId: quote.optionId, name: quote.name, amount: quote.amount.amount };
}

export const StoreOrderSchema = Type.Object(
  {
    id: Type.String({ description: 'Keep it private: anyone with the id can read the order' }),
    number: Type.Integer({ description: 'Human-readable and sequential' }),
    status: Type.Enum(['placed', 'completed', 'canceled']),
    currency: Type.String(),
    email: Type.String(),
    shippingAddress: Type.Ref('StoreAddress'),
    billingAddress: Type.Ref('StoreAddress'),
    shippingMethod: Type.Object({ name: Type.String(), amount: Amount }),
    lines: Type.Array(
      Type.Object({
        id: Type.String(),
        variantId: Type.String(),
        productHandle: Type.String(),
        productTitle: Type.String(),
        variantTitle: Type.String(),
        sku: NullableString,
        quantity: Type.Integer(),
        unitPrice: Amount,
        originalUnitPrice: Type.Union([Amount, Type.Null()]),
        total: Amount,
      }),
    ),
    subtotal: Amount,
    adjustments: Type.Array(
      Type.Object({
        kind: Type.String(),
        label: Type.String(),
        amount: Type.Integer(),
        lineId: Type.Union([Type.String(), Type.Null()]),
        included: Type.Boolean(),
      }),
    ),
    total: Amount,
    placedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'StoreOrder' },
);
export type StoreOrder = Static<typeof StoreOrderSchema>;

export function toStoreOrder(order: Order): StoreOrder {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    currency: order.currency,
    email: order.email,
    shippingAddress: { ...order.shippingAddress },
    billingAddress: { ...order.billingAddress },
    shippingMethod: { name: order.shippingMethod.name, amount: order.shippingMethod.amount.amount },
    lines: order.lines.map((l) => ({
      id: l.id,
      variantId: l.variantId,
      productHandle: l.productHandle,
      productTitle: l.productTitle,
      variantTitle: l.variantTitle,
      sku: l.sku,
      quantity: l.quantity,
      unitPrice: l.unitPrice.amount,
      originalUnitPrice: l.originalUnitPrice?.amount ?? null,
      total: l.total.amount,
    })),
    subtotal: order.subtotal.amount,
    adjustments: order.adjustments.map((a) => ({
      kind: a.kind,
      label: a.label,
      amount: a.amount.amount,
      lineId: a.target.type === 'line' ? a.target.lineId : null,
      included: a.neutral ?? false,
    })),
    total: order.total.amount,
    placedAt: order.placedAt.toISOString(),
  };
}
