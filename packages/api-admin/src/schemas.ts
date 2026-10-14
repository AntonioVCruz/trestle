import { Type, type Static } from 'typebox';
import type {
  Category,
  Channel,
  Price,
  PriceList,
  Product,
  PublishableKey,
  ShippingOption,
  Variant,
} from '@trestle/core';

export const ErrorSchema = Type.Object(
  {
    error: Type.Object({
      code: Type.String(),
      message: Type.String(),
    }),
  },
  { $id: 'Error' },
);
export type ErrorBody = Static<typeof ErrorSchema>;

export const errorBody = (code: string, message: string): ErrorBody => ({ error: { code, message } });

const CurrencyCode = Type.String({ pattern: '^[A-Z]{3}$', description: 'ISO 4217 code' });
const Locale = Type.String({ minLength: 2, maxLength: 35, description: 'BCP 47 language tag' });

export const ChannelSchema = Type.Object(
  {
    id: Type.String(),
    code: Type.String(),
    name: Type.String(),
    defaultCurrency: CurrencyCode,
    currencies: Type.Array(CurrencyCode),
    defaultLocale: Locale,
    locales: Type.Array(Locale),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'Channel' },
);
export type ChannelDto = Static<typeof ChannelSchema>;

export const ChannelListSchema = Type.Object({ data: Type.Array(Type.Ref('Channel')) }, { $id: 'ChannelList' });

export const CreateChannelSchema = Type.Object(
  {
    code: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,62}$', description: 'Stable, URL-safe identifier' }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    defaultCurrency: CurrencyCode,
    currencies: Type.Optional(Type.Array(CurrencyCode, { uniqueItems: true })),
    defaultLocale: Locale,
    locales: Type.Optional(Type.Array(Locale, { uniqueItems: true })),
  },
  { $id: 'CreateChannel', additionalProperties: false },
);

export const PublishableKeySchema = Type.Object(
  {
    key: Type.String(),
    channelId: Type.String(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'PublishableKey' },
);

export function toChannelDto(channel: Channel): ChannelDto {
  return {
    id: channel.id,
    code: channel.code,
    name: channel.name,
    defaultCurrency: channel.defaultCurrency,
    currencies: [...channel.currencies],
    defaultLocale: channel.defaultLocale,
    locales: [...channel.locales],
    createdAt: channel.createdAt.toISOString(),
  };
}

export function toPublishableKeyDto(key: PublishableKey): Static<typeof PublishableKeySchema> {
  return { key: key.key, channelId: key.channelId, createdAt: key.createdAt.toISOString() };
}

export const DEFAULT_PAGE_SIZE = 20;

const Handle = Type.String({
  pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
  maxLength: 100,
  description: 'Stable, URL-safe name, e.g. `blue-t-shirt`',
});
const ProductStatus = Type.Enum(['draft', 'published', 'archived'], {
  description: 'Only `published` products are visible in the Store API',
});
const NullableString = Type.Union([Type.String(), Type.Null()]);

// Request bodies inline their nested objects: a `Type.Ref` would type them as unknown.
const productOptionFields = {
  name: Type.String({ minLength: 1, maxLength: 100 }),
  values: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, uniqueItems: true }),
};
const variantOptionValueFields = { name: Type.String(), value: Type.String() };

export const ProductOptionSchema = Type.Object(productOptionFields, { $id: 'ProductOption' });
export const VariantOptionValueSchema = Type.Object(variantOptionValueFields, { $id: 'VariantOptionValue' });

export const VariantSchema = Type.Object(
  {
    id: Type.String(),
    productId: Type.String(),
    sku: NullableString,
    title: Type.String(),
    options: Type.Array(Type.Ref('VariantOptionValue')),
    position: Type.Integer(),
  },
  { $id: 'Variant' },
);
export type VariantDto = Static<typeof VariantSchema>;

export const ProductSchema = Type.Object(
  {
    id: Type.String(),
    handle: Type.String(),
    title: Type.String(),
    description: NullableString,
    status: ProductStatus,
    options: Type.Array(Type.Ref('ProductOption')),
    variants: Type.Array(Type.Ref('Variant')),
    categoryIds: Type.Array(Type.String()),
    channelIds: Type.Array(Type.String()),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'Product' },
);
export type ProductDto = Static<typeof ProductSchema>;

export const ProductPageSchema = Type.Object(
  {
    data: Type.Array(Type.Ref('Product')),
    nextCursor: Type.Union([Type.String(), Type.Null()], { description: 'Pass as `after` for the next page' }),
  },
  { $id: 'ProductPage' },
);

export const ListProductsQuerySchema = Type.Object({
  status: Type.Optional(ProductStatus),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: DEFAULT_PAGE_SIZE })),
  after: Type.Optional(Type.String({ description: '`nextCursor` from the previous page; anything else is rejected with 400 `invalid_cursor`' })),
});

const variantInputFields = {
  sku: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  options: Type.Optional(
    Type.Array(Type.Object(variantOptionValueFields, { additionalProperties: false }), {
      description: 'One value per product option',
    }),
  ),
};

export const CreateVariantSchema = Type.Object(variantInputFields, { $id: 'CreateVariant', additionalProperties: false });

export const CreateProductSchema = Type.Object(
  {
    handle: Handle,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(NullableString),
    status: Type.Optional(ProductStatus),
    options: Type.Optional(Type.Array(Type.Object(productOptionFields, { additionalProperties: false }))),
    variants: Type.Optional(
      Type.Array(Type.Object(variantInputFields, { additionalProperties: false }), {
        description: 'Required when the product has options; otherwise one default variant is created',
      }),
    ),
  },
  { $id: 'CreateProduct', additionalProperties: false },
);

export const UpdateProductSchema = Type.Object(
  {
    handle: Type.Optional(Handle),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    description: Type.Optional(NullableString),
    status: Type.Optional(ProductStatus),
  },
  { $id: 'UpdateProduct', additionalProperties: false, minProperties: 1 },
);

export const SetProductChannelsSchema = Type.Object(
  { channelIds: Type.Array(Type.String(), { uniqueItems: true }) },
  { $id: 'SetProductChannels', additionalProperties: false },
);

export const SetProductCategoriesSchema = Type.Object(
  { categoryIds: Type.Array(Type.String(), { uniqueItems: true }) },
  { $id: 'SetProductCategories', additionalProperties: false },
);

export const CategorySchema = Type.Object(
  {
    id: Type.String(),
    parentId: NullableString,
    handle: Type.String(),
    name: Type.String(),
    position: Type.Integer(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'Category' },
);
export type CategoryDto = Static<typeof CategorySchema>;

export const CategoryListSchema = Type.Object({ data: Type.Array(Type.Ref('Category')) }, { $id: 'CategoryList' });

export const CreateCategorySchema = Type.Object(
  {
    handle: Handle,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    parentId: Type.Optional(NullableString),
    position: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { $id: 'CreateCategory', additionalProperties: false },
);

export const catalogSchemas = [
  ProductOptionSchema,
  VariantOptionValueSchema,
  VariantSchema,
  ProductSchema,
  ProductPageSchema,
  CreateVariantSchema,
  CreateProductSchema,
  UpdateProductSchema,
  SetProductChannelsSchema,
  SetProductCategoriesSchema,
  CategorySchema,
  CategoryListSchema,
  CreateCategorySchema,
];

export function toVariantDto(variant: Variant): VariantDto {
  return {
    id: variant.id,
    productId: variant.productId,
    sku: variant.sku,
    title: variant.title,
    options: variant.options.map(({ name, value }) => ({ name, value })),
    position: variant.position,
  };
}

export function toProductDto(product: Product): ProductDto {
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    description: product.description,
    status: product.status,
    options: product.options.map(({ name, values }) => ({ name, values: [...values] })),
    variants: product.variants.map(toVariantDto),
    categoryIds: [...product.categoryIds],
    channelIds: [...product.channelIds],
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

export function toCategoryDto(category: Category): CategoryDto {
  return {
    id: category.id,
    parentId: category.parentId,
    handle: category.handle,
    name: category.name,
    position: category.position,
    createdAt: category.createdAt.toISOString(),
  };
}

const Amount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Minor units, e.g. cents' });
const NullableDateTime = Type.Union([Type.String({ format: 'date-time' }), Type.Null()]);
const PriceListStatus = Type.Enum(['draft', 'active'], {
  description: 'Prices of an `active` list apply inside its validity window',
});
const PriceListType = Type.Enum(['sale', 'override'], {
  description:
    '`sale` prices apply only when lower than the regular price, which is then shown as the original; ' +
    '`override` prices replace the regular price, lower or not',
});

export const PriceSchema = Type.Object(
  {
    id: Type.String(),
    variantId: Type.String(),
    priceListId: Type.Union([Type.String(), Type.Null()], { description: 'Null for a base price' }),
    currency: CurrencyCode,
    amount: Amount,
    channelId: Type.Union([Type.String(), Type.Null()], { description: 'Null when the price applies in every channel' }),
    minQuantity: Type.Integer({ minimum: 1 }),
  },
  { $id: 'Price' },
);
export type PriceDto = Static<typeof PriceSchema>;

export const PriceCollectionSchema = Type.Object({ data: Type.Array(Type.Ref('Price')) }, { $id: 'PriceCollection' });

const priceInputFields = {
  currency: CurrencyCode,
  amount: Amount,
  channelId: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Omit for every channel' })),
  minQuantity: Type.Optional(Type.Integer({ minimum: 1, description: 'Tier pricing: applies from this quantity up' })),
};

export const SetVariantPricesSchema = Type.Object(
  { prices: Type.Array(Type.Object(priceInputFields, { additionalProperties: false })) },
  { $id: 'SetVariantPrices', additionalProperties: false },
);

export const SetPriceListPricesSchema = Type.Object(
  {
    prices: Type.Array(
      Type.Object({ variantId: Type.String(), ...priceInputFields }, { additionalProperties: false }),
    ),
  },
  { $id: 'SetPriceListPrices', additionalProperties: false },
);

export const PriceListSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    type: PriceListType,
    status: PriceListStatus,
    priority: Type.Integer({ description: 'Between live lists of the same type, the higher priority wins' }),
    startsAt: NullableDateTime,
    endsAt: NullableDateTime,
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'PriceList' },
);
export type PriceListDto = Static<typeof PriceListSchema>;

export const PriceListListSchema = Type.Object({ data: Type.Array(Type.Ref('PriceList')) }, { $id: 'PriceListList' });

const priceListInputFields = {
  name: Type.String({ minLength: 1, maxLength: 200 }),
  type: Type.Optional(PriceListType),
  status: Type.Optional(PriceListStatus),
  priority: Type.Optional(Type.Integer({ minimum: -1000, maximum: 1000 })),
  startsAt: Type.Optional(NullableDateTime),
  endsAt: Type.Optional(NullableDateTime),
};

export const CreatePriceListSchema = Type.Object(priceListInputFields, {
  $id: 'CreatePriceList',
  additionalProperties: false,
});

export const UpdatePriceListSchema = Type.Object(
  { ...priceListInputFields, name: Type.Optional(priceListInputFields.name) },
  { $id: 'UpdatePriceList', additionalProperties: false, minProperties: 1 },
);

export const pricingSchemas = [
  PriceSchema,
  PriceCollectionSchema,
  SetVariantPricesSchema,
  SetPriceListPricesSchema,
  PriceListSchema,
  PriceListListSchema,
  CreatePriceListSchema,
  UpdatePriceListSchema,
];

export function toPriceDto(price: Price): PriceDto {
  return {
    id: price.id,
    variantId: price.variantId,
    priceListId: price.priceListId,
    currency: price.amount.currency,
    amount: price.amount.amount,
    channelId: price.channelId,
    minQuantity: price.minQuantity,
  };
}

export function toPriceListDto(list: PriceList): PriceListDto {
  return {
    id: list.id,
    name: list.name,
    type: list.type,
    status: list.status,
    priority: list.priority,
    startsAt: list.startsAt?.toISOString() ?? null,
    endsAt: list.endsAt?.toISOString() ?? null,
    createdAt: list.createdAt.toISOString(),
    updatedAt: list.updatedAt.toISOString(),
  };
}

const CountryCode = Type.String({ pattern: '^[A-Z]{2}$', description: 'ISO 3166-1 alpha-2' });
const shippingPriceFields = { currency: CurrencyCode, amount: Amount };
const Countries = Type.Union([Type.Array(CountryCode, { minItems: 1, uniqueItems: true }), Type.Null()], {
  description: 'Countries the option ships to; null for every country',
});

export const ShippingOptionSchema = Type.Object(
  {
    id: Type.String(),
    channelId: Type.String(),
    name: Type.String(),
    countries: Countries,
    active: Type.Boolean(),
    prices: Type.Array(Type.Object(shippingPriceFields)),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'ShippingOption' },
);
export type ShippingOptionDto = Static<typeof ShippingOptionSchema>;

export const ShippingOptionListSchema = Type.Object(
  { data: Type.Array(Type.Ref('ShippingOption')) },
  { $id: 'ShippingOptionList' },
);

const shippingOptionInputFields = {
  name: Type.String({ minLength: 1, maxLength: 200 }),
  countries: Type.Optional(Countries),
  active: Type.Optional(Type.Boolean()),
  prices: Type.Array(Type.Object(shippingPriceFields, { additionalProperties: false }), {
    minItems: 1,
    description: 'A flat price per currency; each must be one of the channel’s currencies',
  }),
};

export const CreateShippingOptionSchema = Type.Object(
  { channelId: Type.String(), ...shippingOptionInputFields },
  { $id: 'CreateShippingOption', additionalProperties: false },
);

export const UpdateShippingOptionSchema = Type.Object(
  {
    name: Type.Optional(shippingOptionInputFields.name),
    countries: shippingOptionInputFields.countries,
    active: shippingOptionInputFields.active,
    prices: Type.Optional(shippingOptionInputFields.prices),
  },
  { $id: 'UpdateShippingOption', additionalProperties: false, minProperties: 1 },
);

export const shippingSchemas = [
  ShippingOptionSchema,
  ShippingOptionListSchema,
  CreateShippingOptionSchema,
  UpdateShippingOptionSchema,
];

export function toShippingOptionDto(option: ShippingOption): ShippingOptionDto {
  return {
    id: option.id,
    channelId: option.channelId,
    name: option.name,
    countries: option.countries && [...option.countries],
    active: option.active,
    prices: option.prices.map((p) => ({ currency: p.currency, amount: p.amount })),
    createdAt: option.createdAt.toISOString(),
    updatedAt: option.updatedAt.toISOString(),
  };
}
