import type { ColumnType, Generated } from 'kysely';

/** `channel_id` is owned by the channel module: a plain id (ADR 0002). */
export interface ShippingOptionTable {
  id: string;
  channel_id: string;
  name: string;
  /** Null ships to every country. */
  countries: string[] | null;
  active: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ShippingOptionPriceTable {
  option_id: string;
  currency: string;
  /** bigint: node-postgres returns it as a string. */
  amount: ColumnType<string, number, number>;
}

export type ShippingTables = {
  shipping_option: ShippingOptionTable;
  shipping_option_price: ShippingOptionPriceTable;
};
