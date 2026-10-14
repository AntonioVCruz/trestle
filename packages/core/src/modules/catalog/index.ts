import { defineModule } from '../../kernel/module.js';
import { migrations } from './migrations.js';
import { createCatalogService } from './service.js';

export const catalogModule = defineModule({
  name: 'catalog',
  migrations,
  createService: createCatalogService,
});

export {
  isHandle,
  productStatusMachine,
  type ProductOption,
  type ProductStatus,
  type VariantInput,
  type VariantOptionValue,
} from './rules.js';
export {
  CATEGORY_CREATED,
  MAX_PAGE_SIZE,
  PRODUCT_CREATED,
  PRODUCT_UPDATED,
  VARIANT_CREATED,
  type AddVariantError,
  type CatalogService,
  type Category,
  type CreateCategoryError,
  type CreateCategoryInput,
  type CreateProductError,
  type CreateProductInput,
  type ListProductsError,
  type ListProductsQuery,
  type Product,
  type ProductFilter,
  type ProductPage,
  type SetProductCategoriesError,
  type SetProductChannelsError,
  type UpdateProductError,
  type UpdateProductInput,
  type Variant,
} from './service.js';
