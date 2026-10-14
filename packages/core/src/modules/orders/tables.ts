import type { ColumnType, Generated } from 'kysely';
import type { OrderStatus } from './rules.js';

type Amount = ColumnType<string, number, number>;
type Json<T> = ColumnType<T, string, string>;

export interface StoredAddress {
  readonly firstName: string;
  readonly lastName: string;
  readonly company: string | null;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly postalCode: string;
  readonly region: string | null;
  readonly country: string;
  readonly phone: string | null;
}

export interface StoredShippingMethod {
  readonly optionId: string;
  readonly name: string;
  readonly amount: number;
}

export interface StoredAdjustment {
  readonly kind: string;
  readonly label: string;
  readonly amount: number;
  readonly target: { readonly type: 'order' } | { readonly type: 'line'; readonly lineId: string };
  readonly neutral?: boolean;
  readonly source: string;
}

/**
 * `sales_order` because `order` is reserved in SQL. Cart, channel, variant, product, shipping
 * option and payment session ids belong to other modules: plain ids (ADR 0002).
 */
export interface SalesOrderTable {
  id: string;
  number: Generated<string>;
  cart_id: string;
  channel_id: string;
  status: Generated<OrderStatus>;
  currency: string;
  email: string;
  shipping_address: Json<StoredAddress>;
  billing_address: Json<StoredAddress>;
  shipping_method: Json<StoredShippingMethod>;
  subtotal: Amount;
  adjustments: Json<StoredAdjustment[]>;
  adjustments_total: Amount;
  total: Amount;
  payment_provider_id: string;
  payment_session_id: string;
  placed_at: Generated<Date>;
}

export interface SalesOrderLineTable {
  id: string;
  order_id: string;
  position: number;
  variant_id: string;
  product_id: string;
  product_handle: string;
  product_title: string;
  variant_title: string;
  sku: string | null;
  quantity: number;
  unit_price: Amount;
  original_unit_price: ColumnType<string | null, number | null, number | null>;
  subtotal: Amount;
  total: Amount;
}

export type OrderTables = {
  sales_order: SalesOrderTable;
  sales_order_line: SalesOrderLineTable;
};
