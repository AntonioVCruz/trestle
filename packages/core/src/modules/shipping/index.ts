import { defineModule } from '../../kernel/module.js';
import { migrations } from './migrations.js';
import { createShippingService } from './service.js';

export const shippingModule = defineModule({
  name: 'shipping',
  migrations,
  createService: createShippingService,
});

export { isCountryCode, type ShippingPriceInput } from './rules.js';
export {
  SHIPPING_OPTION_CREATED,
  SHIPPING_OPTION_UPDATED,
  type CreateShippingOptionError,
  type CreateShippingOptionInput,
  type QuoteContext,
  type ShippingOption,
  type ShippingQuote,
  type ShippingService,
  type UpdateShippingOptionError,
  type UpdateShippingOptionInput,
} from './service.js';
