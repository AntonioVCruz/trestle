import { defineModule } from '../../kernel/module.js';
import { migrations } from './migrations.js';
import { createPricingService } from './service.js';

export const pricingModule = defineModule({
  name: 'pricing',
  migrations,
  createService: createPricingService,
});

export {
  resolvePrice,
  type PriceContext,
  type PriceInput,
  type PriceListStatus,
  type PriceListType,
  type ResolvedPrice,
} from './rules.js';
export {
  PRICE_LIST_CREATED,
  PRICE_LIST_UPDATED,
  VARIANT_PRICES_UPDATED,
  type CreatePriceListError,
  type CreatePriceListInput,
  type Price,
  type PriceList,
  type PriceListPriceInput,
  type PricingService,
  type SetPriceListPricesError,
  type SetVariantPricesError,
  type UpdatePriceListError,
  type UpdatePriceListInput,
} from './service.js';
