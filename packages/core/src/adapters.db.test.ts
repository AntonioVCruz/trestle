import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, type Core } from './core.js';
import { money } from './kernel/money.js';
import { testPaymentProvider } from './modules/payments/index.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from './testing/postgres.js';

/** The cart against the real catalog and pricing services, wired as in production. */
describe.skipIf(!TEST_DATABASE_URL)('cart with catalog and pricing (Postgres)', () => {
  let t: TestDatabase;
  let core: Core;
  let channelId: string;
  let otherChannelId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    core = createCore(t.db, { paymentProviders: [testPaymentProvider()] });
    const eu = await core.channel.create({ code: 'eu', name: 'EU', defaultCurrency: 'EUR', defaultLocale: 'en' });
    const us = await core.channel.create({ code: 'us', name: 'US', defaultCurrency: 'USD', defaultLocale: 'en' });
    if (!eu.ok || !us.ok) throw new Error('channels');
    channelId = eu.value.id;
    otherChannelId = us.value.id;
  });
  afterAll(() => t?.destroy());

  async function product(handle: string, status: 'draft' | 'published', channels: string[]) {
    const created = await core.catalog.createProduct({
      handle,
      title: handle.toUpperCase(),
      status,
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [{ sku: `${handle}-s`, options: [{ name: 'Size', value: 'S' }] }, { options: [{ name: 'Size', value: 'M' }] }],
    });
    if (!created.ok) throw new Error(created.error.message);
    await core.catalog.setProductChannels(created.value.id, channels);
    return created.value;
  }

  it('prices lines with tiers and sales, and copies catalog data onto them', async () => {
    const tee = await product('tee', 'published', [channelId]);
    const [small] = tee.variants;
    await core.pricing.setVariantPrices(small!.id, [
      { currency: 'EUR', amount: 2000 },
      { currency: 'EUR', amount: 1500, minQuantity: 10 },
    ]);
    const sale = await core.pricing.createPriceList({ name: 'Sale', status: 'active' });
    if (!sale.ok) throw new Error('list');
    await core.pricing.setPriceListPrices(sale.value.id, [{ variantId: small!.id, currency: 'EUR', amount: 1800 }]);

    const cart = await core.cart.createCart({ channelId, currency: 'EUR' });
    if (!cart.ok) throw new Error('cart');
    const one = await core.cart.addLine(cart.value.id, { variantId: small!.id, quantity: 1 });
    expect(one.ok && one.value.lines[0]).toMatchObject({
      productHandle: 'tee',
      productTitle: 'TEE',
      variantTitle: 'S',
      sku: 'tee-s',
      unitPrice: money(1800, 'EUR'),
      originalUnitPrice: money(2000, 'EUR'),
      available: true,
    });

    // At ten units the 15.00 tier undercuts the 18.00 sale, so the sale stops applying (ADR 0014).
    const ten = await core.cart.updateLineQuantity(cart.value.id, one.ok ? one.value.lines[0]!.id : '', 10);
    expect(ten.ok && ten.value.lines[0]).toMatchObject({ unitPrice: money(1500, 'EUR'), originalUnitPrice: null });
    expect(ten.ok && ten.value.subtotal).toEqual(money(15_000, 'EUR'));

    // An override list replaces the regular price outright, even above the tier.
    const contract = await core.pricing.createPriceList({ name: 'Contract', type: 'override', status: 'active' });
    if (!contract.ok) throw new Error('list');
    await core.pricing.setPriceListPrices(contract.value.id, [{ variantId: small!.id, currency: 'EUR', amount: 1900 }]);
    const overridden = await core.cart.updateLineQuantity(cart.value.id, one.ok ? one.value.lines[0]!.id : '', 10);
    expect(overridden.ok && overridden.value.lines[0]).toMatchObject({
      unitPrice: money(1800, 'EUR'),
      originalUnitPrice: money(1900, 'EUR'),
    });
  });

  it('checks out through the real shipping module', async () => {
    const box = await product('box', 'published', [channelId]);
    await core.pricing.setVariantPrices(box.variants[0]!.id, [{ currency: 'EUR', amount: 1000 }]);
    const standard = await core.shipping.createOption({ channelId, name: 'Standard', countries: ['DE'], prices: [{ currency: 'EUR', amount: 495 }] });
    await core.shipping.createOption({ channelId: otherChannelId, name: 'Elsewhere', prices: [{ currency: 'EUR', amount: 1 }] });
    if (!standard.ok) throw new Error('option');

    const cart = await core.cart.createCart({ channelId, currency: 'EUR' });
    if (!cart.ok) throw new Error('cart');
    await core.cart.addLine(cart.value.id, { variantId: box.variants[0]!.id, quantity: 1 });
    await core.cart.setAddresses(cart.value.id, {
      email: 'ada@example.com',
      shippingAddress: { firstName: 'Ada', lastName: 'L', line1: '1 Main St', city: 'Berlin', postalCode: '10115', country: 'DE' },
    });
    const options = await core.cart.listShippingOptions(cart.value.id);
    expect(options.ok && options.value.map((o) => o.name)).toEqual(['Standard']);

    const shipped = await core.cart.selectShippingOption(cart.value.id, standard.value.id);
    expect(shipped).toMatchObject({ ok: true, value: { checkoutState: 'shipping_selected', total: money(1495, 'EUR') } });

    // The test provider is offered only once the channel enables it.
    expect(await core.cart.selectPaymentMethod(cart.value.id, { providerId: 'test' })).toMatchObject({
      ok: false,
      error: { code: 'payment_method_unavailable' },
    });
    await core.payments.setProviderChannels('test', [{ channelId }]);
    const paid = await core.cart.selectPaymentMethod(cart.value.id, { providerId: 'test' });
    expect(paid).toMatchObject({
      ok: true,
      value: { checkoutState: 'payment_selected', paymentMethod: { providerId: 'test', amount: money(1495, 'EUR') } },
    });
    const session = await core.payments.getSession(paid.ok ? paid.value.paymentMethod!.sessionId : '');
    expect(session).toMatchObject({ cartId: cart.value.id, amount: money(1495, 'EUR'), status: 'pending' });

    // Deactivating the option takes it out of the cart on the next change.
    await core.shipping.updateOption(standard.value.id, { active: false });
    const after = await core.cart.addLine(cart.value.id, { variantId: box.variants[0]!.id, quantity: 1 });
    expect(after).toMatchObject({
      ok: true,
      value: { checkoutState: 'addressed', shippingMethod: null, paymentMethod: null, total: money(2000, 'EUR') },
    });
  });

  it('only sells published products listed in the cart’s channel', async () => {
    const draft = await product('draft-tee', 'draft', [channelId]);
    const elsewhere = await product('us-tee', 'published', [otherChannelId]);
    for (const p of [draft, elsewhere]) await core.pricing.setVariantPrices(p.variants[0]!.id, [{ currency: 'EUR', amount: 100 }]);

    const cart = await core.cart.createCart({ channelId, currency: 'EUR' });
    if (!cart.ok) throw new Error('cart');
    for (const p of [draft, elsewhere]) {
      expect(await core.cart.addLine(cart.value.id, { variantId: p.variants[0]!.id, quantity: 1 })).toMatchObject({
        ok: false,
        error: { code: 'variant_not_available' },
      });
    }
  });

  it('flags a line when its product is unpublished, and recovers when it returns', async () => {
    const mug = await product('mug', 'published', [channelId]);
    const cap = await product('cap', 'published', [channelId]);
    for (const p of [mug, cap]) await core.pricing.setVariantPrices(p.variants[0]!.id, [{ currency: 'EUR', amount: 500 }]);

    const cart = await core.cart.createCart({ channelId, currency: 'EUR' });
    if (!cart.ok) throw new Error('cart');
    await core.cart.addLine(cart.value.id, { variantId: mug.variants[0]!.id, quantity: 2 });

    await core.catalog.updateProduct(mug.id, { status: 'draft' });
    const flagged = await core.cart.addLine(cart.value.id, { variantId: cap.variants[0]!.id, quantity: 1 });
    expect(flagged.ok && flagged.value.lines.map((l) => l.available)).toEqual([false, true]);
    expect(flagged.ok && flagged.value.total).toEqual(money(500, 'EUR'));

    await core.catalog.updateProduct(mug.id, { status: 'published' });
    const back = await core.cart.addLine(cart.value.id, { variantId: cap.variants[0]!.id, quantity: 1 });
    expect(back.ok && back.value.lines.map((l) => l.available)).toEqual([true, true]);
    expect(back.ok && back.value.total).toEqual(money(2000, 'EUR'));
  });
});
