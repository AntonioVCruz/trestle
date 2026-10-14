import type { ColumnType, Generated } from 'kysely';
import type { PriceListStatus, PriceListType } from './rules.js';

export interface PriceListTable {
  id: string;
  name: string;
  type: PriceListType;
  status: PriceListStatus;
  priority: number;
  starts_at: Date | null;
  ends_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** `variant_id` is owned by the catalog module: a plain id, never joined (ADR 0002). */
export interface PriceSetTable {
  id: string;
  variant_id: string;
  created_at: Generated<Date>;
}

export interface PriceTable {
  id: string;
  price_set_id: string;
  price_list_id: string | null;
  currency: string;
  /** bigint: node-postgres returns it as a string. */
  amount: ColumnType<string, number, number>;
  /** Owned by the channel module: a plain id. */
  channel_id: string | null;
  min_quantity: number;
  created_at: Generated<Date>;
}

export type PricingTables = {
  price_list: PriceListTable;
  price_set: PriceSetTable;
  price: PriceTable;
};
