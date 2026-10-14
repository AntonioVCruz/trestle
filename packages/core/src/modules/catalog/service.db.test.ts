import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../testing/postgres.js';
import type { CatalogService, CreateProductInput, ListProductsQuery } from './service.js';
import { catalogModule } from './index.js';

describe.skipIf(!TEST_DATABASE_URL)('catalog service (Postgres)', () => {
  let t: TestDatabase;
  let catalog: CatalogService;

  beforeAll(async () => {
    t = await createTestDatabase();
    catalog = catalogModule.createService(t.db);
  });
  afterAll(() => t?.destroy());

  const tee: CreateProductInput = {
    handle: 'tee',
    title: 'T-shirt',
    options: [
      { name: 'Size', values: ['S', 'M'] },
      { name: 'Color', values: ['Blue', 'Red'] },
    ],
    variants: [
      { sku: 'TEE-S-BLUE', options: [{ name: 'Size', value: 'S' }, { name: 'Color', value: 'Blue' }] },
      { sku: 'TEE-M-RED', options: [{ name: 'Color', value: 'Red' }, { name: 'Size', value: 'M' }] },
    ],
  };

  const topics = async () =>
    (await sql<{ topic: string }>`select topic from outbox_event order by id`.execute(t.db)).rows.map((r) => r.topic);

  it('creates a product with options and variants, and records its events', async () => {
    const result = await catalog.createProduct(tee);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const product = result.value;
    expect(product).toMatchObject({ handle: 'tee', status: 'draft', description: null, categoryIds: [], channelIds: [] });
    expect(product.options).toEqual(tee.options);
    expect(product.variants.map((v) => [v.sku, v.title, v.position])).toEqual([
      ['TEE-S-BLUE', 'S / Blue', 0],
      ['TEE-M-RED', 'M / Red', 1],
    ]);
    expect(product.variants[1]!.options).toEqual([{ name: 'Size', value: 'M' }, { name: 'Color', value: 'Red' }]);
    expect(await catalog.getProduct(product.id)).toEqual(product);
    expect(await topics()).toEqual(['product.created', 'variant.created', 'variant.created']);
  });

  it('gives a product without options a default variant', async () => {
    const result = await catalog.createProduct({ handle: 'gift-card', title: 'Gift card' });
    expect(result.ok && result.value.variants.map((v) => [v.title, v.sku])).toEqual([['Default', null]]);
  });

  it('refuses taken handles and SKUs without leaving partial rows', async () => {
    expect(await catalog.createProduct(tee)).toMatchObject({ ok: false, error: { code: 'product_handle_taken' } });
    const clash = await catalog.createProduct({ ...tee, handle: 'tee-2' });
    expect(clash).toMatchObject({ ok: false, error: { code: 'sku_taken' } });
    expect(await catalog.getProductByHandle('tee-2')).toBeUndefined();
  });

  it('adds variants after checking options, combinations and SKUs', async () => {
    const product = (await catalog.getProductByHandle('tee'))!;
    const added = await catalog.addVariant(product.id, {
      sku: 'TEE-S-RED',
      options: [{ name: 'Size', value: 'S' }, { name: 'Color', value: 'Red' }],
    });
    expect(added).toMatchObject({ ok: true, value: { title: 'S / Red', position: 2, productId: product.id } });

    const duplicate = await catalog.addVariant(product.id, {
      options: [{ name: 'Size', value: 'S' }, { name: 'Color', value: 'Red' }],
    });
    expect(duplicate).toMatchObject({ ok: false, error: { code: 'invalid_input' } });

    const skuClash = await catalog.addVariant(product.id, {
      sku: 'TEE-S-BLUE',
      options: [{ name: 'Size', value: 'M' }, { name: 'Color', value: 'Blue' }],
    });
    expect(skuClash).toMatchObject({ ok: false, error: { code: 'sku_taken' } });
    expect(await catalog.addVariant('prod_missing', {})).toMatchObject({ ok: false, error: { code: 'product_not_found' } });
    expect((await catalog.getProduct(product.id))!.variants).toHaveLength(3);
  });

  it('looks variants up by id, skipping unknown ones', async () => {
    const product = (await catalog.getProductByHandle('tee'))!;
    const [first, second] = product.variants;
    const found = await catalog.getVariants([second!.id, 'var_missing', first!.id]);
    expect(found.sort((a, b) => a.position - b.position)).toEqual([first, second]);
    expect(await catalog.getVariants([])).toEqual([]);
  });

  it('updates products and enforces the status machine', async () => {
    const product = (await catalog.getProductByHandle('tee'))!;
    const published = await catalog.updateProduct(product.id, { status: 'published', description: 'Soft cotton' });
    expect(published).toMatchObject({ ok: true, value: { status: 'published', description: 'Soft cotton', title: 'T-shirt' } });
    expect(published.ok && published.value.updatedAt > product.updatedAt).toBe(true);

    expect(await catalog.updateProduct(product.id, { status: 'archived' })).toMatchObject({ ok: true });
    expect(await catalog.updateProduct(product.id, { status: 'published' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_status_transition' },
    });
    expect(await catalog.updateProduct(product.id, { status: 'draft' })).toMatchObject({ ok: true });
    expect(await catalog.updateProduct(product.id, { handle: 'gift-card' })).toMatchObject({
      ok: false,
      error: { code: 'product_handle_taken' },
    });
    expect(await catalog.updateProduct('prod_missing', { title: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'product_not_found' },
    });
  });

  it('builds categories and assigns them', async () => {
    const apparel = await catalog.createCategory({ handle: 'apparel', name: 'Apparel' });
    expect(apparel.ok).toBe(true);
    if (!apparel.ok) return;
    const shirts = await catalog.createCategory({ handle: 'shirts', name: 'Shirts', parentId: apparel.value.id });
    expect(shirts).toMatchObject({ ok: true, value: { parentId: apparel.value.id } });
    expect(await catalog.createCategory({ handle: 'shirts', name: 'Again' })).toMatchObject({
      ok: false,
      error: { code: 'category_handle_taken' },
    });
    expect(await catalog.createCategory({ handle: 'orphan', name: 'Orphan', parentId: 'cat_missing' })).toMatchObject({
      ok: false,
      error: { code: 'category_not_found' },
    });
    expect((await catalog.listCategories()).map((c) => c.handle)).toEqual(['apparel', 'shirts']);
    expect((await catalog.getCategoryByHandle('shirts'))?.name).toBe('Shirts');

    const product = (await catalog.getProductByHandle('tee'))!;
    expect(await catalog.setProductCategories(product.id, ['cat_missing'])).toMatchObject({
      ok: false,
      error: { code: 'category_not_found' },
    });
    const assigned = await catalog.setProductCategories(product.id, [apparel.value.id, apparel.value.id]);
    expect(assigned.ok && assigned.value.categoryIds).toEqual([apparel.value.id]);
  });

  describe('listing', () => {
    const channel = 'chn_listing';
    let categoryId: string;

    beforeAll(async () => {
      const category = await catalog.createCategory({ handle: 'listing', name: 'Listing' });
      if (!category.ok) throw new Error(category.error.message);
      categoryId = category.value.id;

      for (let i = 0; i < 5; i++) {
        const created = await catalog.createProduct({
          handle: `item-${i}`,
          title: `Item ${i}`,
          status: i === 4 ? 'draft' : 'published',
          options: [{ name: 'Size', values: ['S', 'M'] }],
          variants: [{ options: [{ name: 'Size', value: 'S' }] }, { options: [{ name: 'Size', value: 'M' }] }],
        });
        if (!created.ok) throw new Error(created.error.message);
        // item-3 is published but not listed in the channel.
        if (i !== 3) await catalog.setProductChannels(created.value.id, [channel, 'chn_other']);
        if (i % 2 === 0) await catalog.setProductCategories(created.value.id, [categoryId]);
      }
    });

    const storeFilter = { status: 'published', channelId: channel } as const;
    const list = async (query: ListProductsQuery) => {
      const result = await catalog.listProducts(query);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };

    it('pages through published products in a channel, newest first', async () => {
      const first = await list({ ...storeFilter, limit: 2 });
      expect(first.items.map((p) => p.handle)).toEqual(['item-2', 'item-1']);
      expect(first.items[0]!.channelIds).toEqual([channel, 'chn_other']);
      expect(first.nextCursor).toBe(first.items[1]!.id);

      const second = await list({ ...storeFilter, limit: 2, after: first.nextCursor! });
      expect(second.items.map((p) => p.handle)).toEqual(['item-0']);
      expect(second.nextCursor).toBeNull();
    });

    it('rejects a cursor it did not hand out, instead of starting over', async () => {
      for (const after of ['x', 'prod_9', 'ord_01a116a9fef8ea0a84798e935e441f42']) {
        expect(await catalog.listProducts({ ...storeFilter, limit: 2, after })).toMatchObject({ ok: false, error: { code: 'invalid_cursor' } });
      }
    });

    it('accepts a well-formed cursor whose product is gone: it is only a position', async () => {
      const page = await list({ ...storeFilter, limit: 10, after: 'prod_ffffffffffffffffffffffffffffffff' });
      expect(page.items.map((p) => p.handle)).toEqual(['item-2', 'item-1', 'item-0']);
    });

    it('filters by category', async () => {
      const page = await list({ ...storeFilter, categoryId, limit: 10 });
      expect(page.items.map((p) => p.handle)).toEqual(['item-2', 'item-0']);
    });

    it('applies the same filter when fetching by handle', async () => {
      expect(await catalog.getProductByHandle('item-0', storeFilter)).toBeDefined();
      expect(await catalog.getProductByHandle('item-3', storeFilter)).toBeUndefined();
      expect(await catalog.getProductByHandle('item-4', storeFilter)).toBeUndefined();
      expect(await catalog.getProductByHandle('item-4')).toBeDefined();
    });

    it('loads a page in a constant number of queries', async () => {
      t.resetQueryCount();
      await list({ limit: 1 });
      const one = t.queryCount();

      t.resetQueryCount();
      const page = await list({ limit: 100 });
      expect(page.items.length).toBeGreaterThan(5);
      expect(t.queryCount()).toBe(one);
      expect(one).toBe(6);
    });
  });
});
