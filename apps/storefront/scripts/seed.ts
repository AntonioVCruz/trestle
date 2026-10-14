/**
 * Demo data for developing the reference storefront: a two-currency channel, a category tree, a
 * few dozen variants, a sale, a shipping option and the test payment provider. Like the
 * storefront, it uses only the public API (here the Admin API, through @trestle/sdk).
 *
 *   npm run seed     # needs the server running, and ADMIN_API_TOKEN in .env
 *
 * Running it again leaves the data alone and just issues a fresh publishable key.
 */
import { createAdminClient } from '@trestle/sdk';

const CHANNEL_CODE = 'demo';
const baseUrl = process.env.TRESTLE_API_URL ?? 'http://localhost:9000';
const token = process.env.ADMIN_API_TOKEN;
if (!token) {
  console.error('ADMIN_API_TOKEN is not set. Put it in .env (see .env.example).');
  process.exit(1);
}
const admin = createAdminClient({ baseUrl, token });

/** Unwraps an SDK result, failing loudly with the API's error. */
function must<T>(result: { data?: T; error?: unknown; response: Response }, what: string): T {
  if (result.data === undefined) {
    throw new Error(`${what} failed with HTTP ${result.response.status}: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

interface DemoProduct {
  readonly handle: string;
  readonly title: string;
  readonly description: string;
  readonly categories: readonly string[];
  /** USD cents; EUR is set a little lower. */
  readonly price: number;
  readonly options?: readonly { readonly name: string; readonly values: readonly string[] }[];
  /** Combinations that do not exist, as "M/Black". Every other combination becomes a variant. */
  readonly missing?: readonly string[];
  /** Per-variant price overrides, keyed by the same "M/Black" form. */
  readonly prices?: Readonly<Record<string, number>>;
  readonly sku?: string;
  /** Sale price in USD cents for every variant, through a price list. */
  readonly sale?: number;
}

// Listed oldest first: the Store API lists newest first, so the last one here shows first.
const products: readonly DemoProduct[] = [
  {
    handle: 'denim-jacket',
    title: 'Denim Jacket',
    description: 'Rigid denim that softens with wear. Two chest pockets, metal buttons.',
    categories: ['men'],
    price: 12800,
    options: [{ name: 'Size', values: ['S', 'M', 'L', 'XL'] }],
  },
  {
    handle: 'pleated-skirt',
    title: 'Pleated Skirt',
    description: 'A midi skirt with soft pleats and a hidden side zip.',
    categories: ['women', 'bottoms'],
    price: 6600,
    options: [{ name: 'Size', values: ['XS', 'S', 'M', 'L'] }],
  },
  {
    handle: 'silk-scarf',
    title: 'Silk Scarf',
    description: 'Hand-rolled edges, printed in small runs.',
    categories: ['accessories'],
    price: 4500,
  },
  {
    handle: 'merino-crew',
    title: 'Merino Crew',
    description: 'Fine-gauge merino. Warm without bulk.\n\nHand wash cold, dry flat.',
    categories: ['women', 'tops', 'men'],
    price: 8200,
    options: [
      { name: 'Size', values: ['S', 'M', 'L'] },
      { name: 'Color', values: ['Oat', 'Navy'] },
    ],
  },
  {
    handle: 'wide-leg-trousers',
    title: 'Wide-Leg Trousers',
    description: 'High-waisted, fully lined, with a pressed crease.',
    categories: ['women', 'bottoms'],
    price: 7200,
    options: [{ name: 'Size', values: ['XS', 'S', 'M', 'L'] }],
  },
  {
    handle: 'oxford-shirt',
    title: 'Oxford Shirt',
    description: 'Button-down collar, a chest pocket and a curved hem.',
    categories: ['men', 'shirts'],
    price: 5800,
    options: [
      { name: 'Size', values: ['S', 'M', 'L'] },
      { name: 'Color', values: ['White', 'Blue'] },
    ],
  },
  {
    handle: 'rib-socks-3-pack',
    title: 'Rib Socks, 3-pack',
    description: 'Cotton-rich ribbed socks in three colours.',
    categories: ['accessories'],
    price: 1800,
  },
  {
    handle: 'leather-belt',
    title: 'Leather Belt',
    description: 'Vegetable-tanned leather with a solid brass buckle.',
    categories: ['accessories'],
    price: 4200,
    options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
    prices: { L: 4600 },
  },
  {
    handle: 'cord-overshirt',
    title: 'Cord Overshirt',
    description: 'Midweight corduroy, cut to layer over a tee or a knit.',
    categories: ['men', 'shirts'],
    price: 8900,
    options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
  },
  {
    handle: 'relaxed-chino',
    title: 'Relaxed Chino',
    description: 'A relaxed fit in garment-dyed cotton twill.',
    categories: ['men', 'trousers'],
    price: 6400,
    options: [{ name: 'Waist', values: ['30', '32', '34'] }],
    prices: { '34': 6800 },
  },
  {
    handle: 'canvas-tote',
    title: 'Canvas Tote',
    description: 'Heavy cotton canvas with an inside pocket.',
    categories: ['accessories'],
    price: 3500,
    sku: 'CT-001',
  },
  {
    handle: 'wool-beanie',
    title: 'Wool Beanie',
    description: 'A ribbed beanie in soft lambswool.',
    categories: ['accessories'],
    price: 2200,
  },
  {
    handle: 'linen-tee',
    title: 'Linen Tee',
    description: 'A relaxed tee in washed linen. Gets softer every wash.\n\nMachine wash cold, line dry.',
    categories: ['women', 'tops'],
    price: 2800,
    options: [
      { name: 'Size', values: ['S', 'M', 'L'] },
      { name: 'Color', values: ['Blue', 'Red', 'Black'] },
    ],
    missing: ['M/Black'],
    prices: { 'L/Blue': 3000, 'L/Red': 3000, 'L/Black': 3000 },
    sale: 2400,
  },
];

const categoryTree = [
  { handle: 'women', name: 'Women', children: [['tops', 'Tops'], ['bottoms', 'Bottoms'], ['outerwear', 'Outerwear']] },
  { handle: 'men', name: 'Men', children: [['shirts', 'Shirts'], ['trousers', 'Trousers']] },
  { handle: 'accessories', name: 'Accessories', children: [] },
] as const;

const eur = (usd: number) => Math.round((usd * 0.92) / 100) * 100;

/** Every combination of the option values, as lists of { name, value }. */
function combinations(options: DemoProduct['options'] = []) {
  return options.reduce<{ name: string; value: string }[][]>(
    (combos, option) => combos.flatMap((combo) => option.values.map((value) => [...combo, { name: option.name, value }])),
    [[]],
  );
}

async function main() {
  const channels = must(await admin.GET('/admin/v1/channels'), 'Listing channels');
  const existing = channels.data.find((c) => c.code === CHANNEL_CODE);
  if (existing) {
    console.log(`The "${CHANNEL_CODE}" channel already exists; leaving its data alone.`);
    await printKey(existing.id);
    return;
  }

  const channel = must(
    await admin.POST('/admin/v1/channels', {
      body: { code: CHANNEL_CODE, name: 'Demo Store', defaultCurrency: 'USD', currencies: ['USD', 'EUR'], defaultLocale: 'en' },
    }),
    'Creating the channel',
  );

  const categoryIds = new Map<string, string>();
  for (const [position, top] of categoryTree.entries()) {
    const parent = must(await admin.POST('/admin/v1/categories', { body: { handle: top.handle, name: top.name, position } }), `Category ${top.handle}`);
    categoryIds.set(top.handle, parent.id);
    for (const [childPosition, [handle, name]] of top.children.entries()) {
      const child = must(
        await admin.POST('/admin/v1/categories', { body: { handle, name, parentId: parent.id, position: childPosition } }),
        `Category ${handle}`,
      );
      categoryIds.set(handle, child.id);
    }
  }

  const onSale: { variantId: string; amount: number }[] = [];
  for (const p of products) {
    const combos = combinations(p.options).filter((combo) => !p.missing?.includes(combo.map((o) => o.value).join('/')));
    const created = must(
      await admin.POST('/admin/v1/products', {
        body: {
          handle: p.handle,
          title: p.title,
          description: p.description,
          status: 'published',
          ...(p.options
            ? {
                options: p.options.map((o) => ({ name: o.name, values: [...o.values] })),
                variants: combos.map((options) => ({
                  title: options.map((o) => o.value).join(' / '),
                  sku: [p.handle, ...options.map((o) => o.value)].join('-').toUpperCase(),
                  options,
                })),
              }
            : { variants: [{ sku: p.sku ?? p.handle.toUpperCase() }] }),
        },
      }),
      `Product ${p.handle}`,
    );
    must(await admin.PUT('/admin/v1/products/{id}/channels', { params: { path: { id: created.id } }, body: { channelIds: [channel.id] } }), `Channels of ${p.handle}`);
    must(
      await admin.PUT('/admin/v1/products/{id}/categories', {
        params: { path: { id: created.id } },
        body: { categoryIds: p.categories.map((handle) => categoryIds.get(handle)!) },
      }),
      `Categories of ${p.handle}`,
    );

    for (const variant of created.variants) {
      const key = variant.options.map((o) => o.value).join('/');
      const usd = p.prices?.[key] ?? p.price;
      must(
        await admin.PUT('/admin/v1/variants/{id}/prices', {
          params: { path: { id: variant.id } },
          body: { prices: [{ currency: 'USD', amount: usd }, { currency: 'EUR', amount: eur(usd) }] },
        }),
        `Prices of ${p.handle} ${key}`,
      );
      if (p.sale) onSale.push({ variantId: variant.id, amount: p.sale });
    }
  }

  if (onSale.length > 0) {
    const sale = must(
      await admin.POST('/admin/v1/price-lists', { body: { name: 'Demo sale', type: 'sale', status: 'active' } }),
      'Creating the sale',
    );
    const prices = onSale.flatMap(({ variantId, amount }) => [
      { variantId, currency: 'USD', amount },
      { variantId, currency: 'EUR', amount: eur(amount) },
    ]);
    must(await admin.PUT('/admin/v1/price-lists/{id}/prices', { params: { path: { id: sale.id } }, body: { prices } }), 'Sale prices');
  }

  must(
    await admin.POST('/admin/v1/shipping-options', {
      body: { channelId: channel.id, name: 'Standard', prices: [{ currency: 'USD', amount: 500 }, { currency: 'EUR', amount: 500 }] },
    }),
    'Shipping option',
  );

  const providers = must(await admin.GET('/admin/v1/payment-providers'), 'Listing payment providers');
  if (providers.data.some((p) => p.id === 'test')) {
    must(
      await admin.PUT('/admin/v1/payment-providers/{id}/channels', {
        params: { path: { id: 'test' } },
        body: { channels: [{ channelId: channel.id, captureMode: 'immediate' }] },
      }),
      'Enabling the test payment provider',
    );
  } else {
    console.warn('The test payment provider is not registered (ENABLE_TEST_PAYMENT_PROVIDER); checkout will offer no payment method.');
  }

  console.log(`Created the "${CHANNEL_CODE}" channel: ${categoryIds.size} categories, ${products.length} products.`);
  await printKey(channel.id);
}

async function printKey(channelId: string) {
  const { key } = must(await admin.POST('/admin/v1/channels/{id}/publishable-keys', { params: { path: { id: channelId } } }), 'Issuing a key');
  console.log(`\nAdd this to .env for the storefront:\n\nTRESTLE_PUBLISHABLE_KEY=${key}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
