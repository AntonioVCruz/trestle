import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money } from '../../kernel/money.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../testing/postgres.js';
import { shippingModule, type ShippingService } from './index.js';

describe.skipIf(!TEST_DATABASE_URL)('shipping service (Postgres)', () => {
  let t: TestDatabase;
  let shipping: ShippingService;

  beforeAll(async () => {
    t = await createTestDatabase();
    shipping = shippingModule.createService(t.db);
  });
  afterAll(() => t?.destroy());

  it('creates options with prices and validates them', async () => {
    const created = await shipping.createOption({
      channelId: 'chn_eu',
      name: 'Standard',
      prices: [
        { currency: 'EUR', amount: 495 },
        { currency: 'USD', amount: 595 },
      ],
    });
    expect(created).toMatchObject({
      ok: true,
      value: { name: 'Standard', countries: null, active: true, prices: [money(495, 'EUR'), money(595, 'USD')] },
    });

    for (const input of [
      { channelId: 'chn_eu', name: ' ', prices: [{ currency: 'EUR', amount: 1 }] },
      { channelId: 'chn_eu', name: 'X', prices: [] },
      { channelId: 'chn_eu', name: 'X', prices: [{ currency: 'EUR', amount: 1 }, { currency: 'EUR', amount: 2 }] },
      { channelId: 'chn_eu', name: 'X', prices: [{ currency: 'EUR', amount: 1 }], countries: [] },
      { channelId: 'chn_eu', name: 'X', prices: [{ currency: 'EUR', amount: 1 }], countries: ['de'] },
    ]) {
      expect(await shipping.createOption(input)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    }
  });

  it('quotes active options of the channel for a country and currency, cheapest first', async () => {
    await shipping.createOption({ channelId: 'chn_eu', name: 'Express DE', countries: ['DE'], prices: [{ currency: 'EUR', amount: 1500 }] });
    await shipping.createOption({ channelId: 'chn_eu', name: 'Pickup', countries: ['DE', 'AT'], prices: [{ currency: 'EUR', amount: 0 }] });
    await shipping.createOption({ channelId: 'chn_us', name: 'US only', prices: [{ currency: 'EUR', amount: 100 }] });
    const off = await shipping.createOption({ channelId: 'chn_eu', name: 'Off', active: false, prices: [{ currency: 'EUR', amount: 1 }] });
    expect(off.ok).toBe(true);

    const names = async (country: string, currency = 'EUR') =>
      (await shipping.quotes({ channelId: 'chn_eu', currency, country })).map((q) => q.name);

    expect(await names('DE')).toEqual(['Pickup', 'Standard', 'Express DE']);
    expect(await names('AT')).toEqual(['Pickup', 'Standard']);
    expect(await names('FR')).toEqual(['Standard']);
    expect(await names('DE', 'USD')).toEqual(['Standard']);
    expect((await shipping.quotes({ channelId: 'chn_eu', currency: 'EUR', country: 'DE' }))[2]).toMatchObject({
      amount: money(1500, 'EUR'),
    });
  });

  it('updates options, replacing prices', async () => {
    const [standard] = await shipping.listOptions({ channelId: 'chn_eu' });
    const updated = await shipping.updateOption(standard!.id, { countries: ['FR'], prices: [{ currency: 'EUR', amount: 695 }] });
    expect(updated).toMatchObject({ ok: true, value: { countries: ['FR'], prices: [money(695, 'EUR')] } });

    const quotes = await shipping.quotes({ channelId: 'chn_eu', currency: 'EUR', country: 'FR' });
    expect(quotes).toEqual([{ optionId: standard!.id, name: 'Standard', amount: money(695, 'EUR') }]);

    expect(await shipping.updateOption('ship_x', { active: false })).toMatchObject({
      ok: false,
      error: { code: 'shipping_option_not_found' },
    });
    expect((await shipping.listOptions()).length).toBe(5);
  });
});
