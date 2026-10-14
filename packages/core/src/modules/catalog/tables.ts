import type { Generated } from 'kysely';
import type { ProductStatus } from './rules.js';

export interface ProductTable {
  id: string;
  handle: string;
  title: string;
  description: string | null;
  status: ProductStatus;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProductOptionTable {
  id: string;
  product_id: string;
  name: string;
  position: number;
}

export interface ProductOptionValueTable {
  id: string;
  option_id: string;
  value: string;
  position: number;
}

export interface ProductVariantTable {
  id: string;
  product_id: string;
  sku: string | null;
  title: string;
  position: number;
  created_at: Generated<Date>;
}

export interface ProductVariantOptionValueTable {
  variant_id: string;
  option_value_id: string;
}

export interface CategoryTable {
  id: string;
  parent_id: string | null;
  handle: string;
  name: string;
  position: number;
  created_at: Generated<Date>;
}

export interface ProductCategoryTable {
  product_id: string;
  category_id: string;
}

/** `channel_id` is owned by the channel module: a plain id, never joined (ADR 0002). */
export interface ProductChannelTable {
  product_id: string;
  channel_id: string;
}

export type CatalogTables = {
  product: ProductTable;
  product_option: ProductOptionTable;
  product_option_value: ProductOptionValueTable;
  product_variant: ProductVariantTable;
  product_variant_option_value: ProductVariantOptionValueTable;
  category: CategoryTable;
  product_category: ProductCategoryTable;
  product_channel: ProductChannelTable;
};
