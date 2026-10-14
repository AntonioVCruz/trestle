import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money } from '../../kernel/money.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../testing/postgres.js';
import { pricingModule, type PricingService } from './index.js';

describe.skipIf(!TEST_DATABASE_URL)('pricing service (Postgres)', () => {
  let t: TestDatabase;
  let pricing: PricingService;

  beforeAll(async () => {
    t = await createTestDatabase();
    pricing = pricingModule.createService(t.db);
  });
  afterAll(() => t?.destroy());

  const at = new Date();
  const eu = { currency: 'EUR', channelId: 'chn_eu', quantity: 1, at };

  it('replaces base prices and keeps large amounts exact', async () => {
    const first = await pricing.setVariantPrices('var_a', [
      { currency: 'EUR', amount: 1000 },
      { currency: 'USD', amount: 1200 },
    ]);
    expect(first.ok && first.value.map((p) => p.amount)).toEqual([money(1000, 'EUR'), money(1200, 'USD')]);

    const big = 900_719_925_474_099;
    const second = await pricing.setVariantPrices('var_a', [
      { currency: 'EUR', amount: 1000 },
      { currency: 'EUR', amount: 800, minQuantity: 10 },
      { currency: 'JPY', amount: big },
    ]);
    expect(second.ok && second.value.map((p) => [p.amount.currency, p.amount.amount, p.minQuantity])).toEqual([
      ['EUR', 1000, 1],
      ['EUR', 800, 10],
      ['JPY', big, 1],
    ]);
    expect(await pricing.listVariantPrices('var_a')).toHaveLength(3);
  });

  it('rejects invalid prices without writing', async () => {
    const result = await pricing.setVariantPrices('var_a', [{ currency: 'EUR', amount: -5 }]);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await pricing.listVariantPrices('var_a')).toHaveLength(3);
  });

  it('creates and updates price lists, checking their window', async () => {
    const created = await pricing.createPriceList({ name: 'Summer sale', priority: 1 });
    expect(created).toMatchObject({ ok: true, value: { type: 'sale', status: 'draft', priority: 1, startsAt: null } });
    if (!created.ok) return;
    const { id } = created.value;

    const bad = await pricing.updatePriceList(id, { startsAt: new Date('2026-07-01'), endsAt: new Date('2026-06-01') });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await pricing.updatePriceList('plist_missing', { name: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'price_list_not_found' },
    });
    expect(await pricing.createPriceList({ name: ' ' })).toMatchObject({ ok: false });
    expect((await pricing.listPriceLists()).map((l) => l.name)).toEqual(['Summer sale']);
  });

  it('resolves base, tier and list prices for many variants in one query', async () => {
    await pricing.setVariantPrices('var_b', [
      { currency: 'EUR', amount: 2000 },
      { currency: 'EUR', amount: 2100, channelId: 'chn_eu' },
    ]);
    const list = (await pricing.listPriceLists())[0]!;
    const set = await pricing.setPriceListPrices(list.id, [
      { variantId: 'var_a', currency: 'EUR', amount: 750 },
      { variantId: 'var_new', currency: 'EUR', amount: 50 },
    ]);
    expect(set.ok && set.value.map((p) => p.variantId)).toEqual(['var_a', 'var_new']);

    // The list is still a draft: base prices apply.
    t.resetQueryCount();
    let resolved = await pricing.resolvePrices(['var_a', 'var_b', 'var_new', 'var_unpriced'], eu);
    expect(t.queryCount()).toBe(1);
    expect(resolved.get('var_a')).toMatchObject({ amount: money(1000, 'EUR'), priceListId: null, original: null });
    expect(resolved.get('var_b')?.amount).toEqual(money(2100, 'EUR'));
    expect(resolved.has('var_new')).toBe(false);
    expect(resolved.has('var_unpriced')).toBe(false);
    expect((await pricing.resolvePrices(['var_a'], { ...eu, quantity: 12 })).get('var_a')?.amount).toEqual(money(800, 'EUR'));

    await pricing.updatePriceList(list.id, { status: 'active' });
    resolved = await pricing.resolvePrices(['var_a', 'var_new'], eu);
    expect(resolved.get('var_a')).toMatchObject({
      amount: money(750, 'EUR'),
      priceListId: list.id,
      original: money(1000, 'EUR'),
    });
    expect(resolved.get('var_new')).toMatchObject({ amount: money(50, 'EUR'), original: null });

    // Ending the window turns the sale off again.
    await pricing.updatePriceList(list.id, { endsAt: new Date(Date.now() - 1000), startsAt: new Date(Date.now() - 60_000) });
    expect((await pricing.resolvePrices(['var_a'], { ...eu, at: new Date() })).get('var_a')?.priceListId).toBeNull();
  });

  it('replaces a list’s prices wholesale and leaves base prices alone', async () => {
    const list = (await pricing.listPriceLists())[0]!;
    const result = await pricing.setPriceListPrices(list.id, [{ variantId: 'var_b', currency: 'EUR', amount: 1500 }]);
    expect(result.ok && result.value.map((p) => p.variantId)).toEqual(['var_b']);
    expect((await pricing.listVariantPrices('var_a')).filter((p) => p.priceListId === null)).toHaveLength(3);

    const dup = await pricing.setPriceListPrices(list.id, [
      { variantId: 'var_b', currency: 'EUR', amount: 1 },
      { variantId: 'var_b', currency: 'EUR', amount: 2 },
    ]);
    expect(dup).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await pricing.setPriceListPrices('plist_missing', [])).toMatchObject({
      ok: false,
      error: { code: 'price_list_not_found' },
    });
  });

  it('resolves override lists, and lets a list change type', async () => {
    await pricing.setVariantPrices('var_o', [{ currency: 'EUR', amount: 1000 }]);
    const created = await pricing.createPriceList({ name: 'B2B', type: 'override', status: 'active' });
    if (!created.ok) throw new Error(created.error.message);
    await pricing.setPriceListPrices(created.value.id, [{ variantId: 'var_o', currency: 'EUR', amount: 1200 }]);

    let resolved = (await pricing.resolvePrices(['var_o'], { ...eu, at: new Date() })).get('var_o');
    expect(resolved).toMatchObject({ amount: money(1200, 'EUR'), priceListId: created.value.id, original: null });

    // As a sale, a higher price no longer applies.
    const changed = await pricing.updatePriceList(created.value.id, { type: 'sale' });
    expect(changed).toMatchObject({ ok: true, value: { type: 'sale' } });
    resolved = (await pricing.resolvePrices(['var_o'], { ...eu, at: new Date() })).get('var_o');
    expect(resolved).toMatchObject({ amount: money(1000, 'EUR'), priceListId: null });
  });

  it('records events in the same transaction', async () => {
    const topics = (await sql<{ topic: string }>`select distinct topic from outbox_event order by topic`.execute(t.db)).rows;
    expect(topics.map((r) => r.topic)).toEqual(['price_list.created', 'price_list.updated', 'variant_prices.updated']);
  });
});
