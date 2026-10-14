import type { ColumnType, Generated } from 'kysely';
import type { CheckoutState } from '../checkout/index.js';
import type { Address } from './checkout.js';

/** bigint money columns: node-postgres returns them as strings. */
type Amount = ColumnType<string, number, number>;

/** An adjustment as stored: amounts in the cart's currency, as minor units. */
export interface StoredAdjustment {
  readonly kind: string;
  readonly label: string;
  readonly amount: number;
  readonly target: { readonly type: 'order' } | { readonly type: 'line'; readonly lineId: string };
  readonly neutral?: boolean;
  readonly source: string;
}

/** `channel_id` is owned by the channel module: a plain id (ADR 0002). */
export interface CartTable {
  id: string;
  channel_id: string;
  currency: string;
  subtotal: Amount;
  adjustments: ColumnType<StoredAdjustment[], string, string>;
  adjustments_total: Amount;
  total: Amount;
  checkout_state: Generated<CheckoutState>;
  email: string | null;
  shipping_address: ColumnType<Address | null, string | null, string | null>;
  billing_address: ColumnType<Address | null, string | null, string | null>;
  /** Owned by the shipping module: a plain id. */
  shipping_option_id: string | null;
  shipping_option_name: string | null;
  shipping_amount: ColumnType<string | null, number | null, number | null>;
  payment_provider_id: string | null;
  payment_provider_name: string | null;
  /** Owned by the payments module: a plain id. */
  payment_session_id: string | null;
  payment_amount: ColumnType<string | null, number | null, number | null>;
  payment_client_data: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  completion_key: string | null;
  completion_started_at: Date | null;
  /** Owned by the orders module: a plain id. */
  order_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Variant and product ids are owned by the catalog; titles are copies taken when priced. */
export interface CartLineTable {
  id: string;
  cart_id: string;
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
  available: boolean;
  created_at: Generated<Date>;
}

export type CartTables = {
  cart: CartTable;
  cart_line: CartLineTable;
};
