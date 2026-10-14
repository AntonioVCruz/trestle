import type { StoreSchemas } from '@trestle/sdk';

type Schemas = StoreSchemas['schemas'];

export type Channel = Schemas['StoreChannel'];
export type Category = Schemas['StoreCategory'];
export type Product = Schemas['StoreProduct'];
export type Variant = Schemas['StoreVariant'];
export type Price = Schemas['StorePrice'];
export type Cart = Schemas['StoreCart'];
export type CartLine = Schemas['StoreCartLine'];
export type Address = Schemas['StoreAddress'];
export type ShippingQuote = Schemas['StoreShippingQuote'];
export type PaymentMethod = Schemas['StorePaymentMethod'];
export type Order = Schemas['StoreOrder'];
