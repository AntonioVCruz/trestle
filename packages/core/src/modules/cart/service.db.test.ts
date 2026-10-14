import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { money } from '../../kernel/money.js';
import { err, ok } from '../../kernel/result.js';
import type { Adjuster } from '../../kernel/totals.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../testing/postgres.js';
import type { LinePrice, SellableVariant } from './rules.js';
import { cartModule, type CartService } from './index.js';

describe.skipIf(!TEST_DATABASE_URL)('cart service (Postgres)', () => {
  let t: TestDatabase;
  let carts: CartService;

  // Fakes for the catalog and pricing ports; tests change what is for sale and at what price.
  let forSale = new Set<string>();
  let prices = new Map<string, number>();
  const tiers = new Map<string, { from: number; amount: number }>();
  // Shipping options by id: name, price in minor units, countries served.
  let shippingOptions = new Map<string, { name: string; amount: number; countries: string[] }>();
  // Payments fake: which providers exist, and a hook that runs while a session is being prepared.
  const sessions: { providerId: string; amount: number }[] = [];
  let duringSession: () => Promise<void> = async () => {};

  const discount: Adjuster = {
    id: 'test.order-discount',
    priority: 0,
    adjust: ({ subtotal }) =>
      subtotal.amount >= 5000 ? [{ kind: 'promotion', label: '5 off', amount: money(-500, subtotal.currency), target: { type: 'order' } }] : [],
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    carts = cartModule.createService(t.db, {
      catalog: {
        sellableVariants: async (ids) =>
          new Map(
            ids
              .filter((id) => forSale.has(id))
              .map((id): [string, SellableVariant] => [
                id,
                { variantId: id, productId: `prod_${id}`, productHandle: `h-${id}`, productTitle: `P ${id}`, variantTitle: `V ${id}`, sku: null },
              ]),
          ),
      },
      pricing: {
        unitPrices: async (lines, { currency }) =>
          new Map(
            lines
              .filter((l) => prices.has(l.variantId))
              .map(({ variantId, quantity }): [string, LinePrice] => {
                const tier = tiers.get(variantId);
                const amount = tier && quantity >= tier.from ? tier.amount : prices.get(variantId)!;
                return [variantId, { unitPrice: money(amount, currency), originalUnitPrice: null }];
              }),
          ),
      },
      shipping: {
        quotes: async ({ currency, country }) =>
          [...shippingOptions]
            .filter(([, o]) => o.countries.includes(country))
            .map(([optionId, o]) => ({ optionId, name: o.name, amount: money(o.amount, currency) })),
      },
      payments: {
        methods: async () => [{ providerId: 'test', name: 'Test payments' }],
        startSession: async ({ providerId, amount }) => {
          if (providerId !== 'test') return err('payment_method_unavailable', 'nope');
          await duringSession();
          sessions.push({ providerId, amount: amount.amount });
          return ok({ providerId, name: 'Test payments', sessionId: `pays_${sessions.length}`, amount, clientData: { ready: true } });
        },
      },
      adjusters: [discount],
    });
  });
  afterAll(() => t?.destroy());
  beforeEach(() => {
    forSale = new Set(['var_a', 'var_b']);
    prices = new Map([
      ['var_a', 1000],
      ['var_b', 2500],
    ]);
    tiers.clear();
    shippingOptions = new Map([
      ['ship_std', { name: 'Standard', amount: 495, countries: ['DE', 'FR'] }],
      ['ship_exp', { name: 'Express', amount: 1500, countries: ['DE'] }],
    ]);
  });

  async function newCart() {
    const created = await carts.createCart({ channelId: 'chn_eu', currency: 'EUR' });
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  }

  it('creates an empty cart', async () => {
    const cart = await newCart();
    expect(cart).toMatchObject({ channelId: 'chn_eu', currency: 'EUR', lines: [], total: money(0, 'EUR') });
    expect(await carts.getCart(cart.id)).toEqual(cart);
    expect(await carts.createCart({ channelId: 'chn_eu', currency: 'eur' })).toMatchObject({ ok: false });
  });

  it('adds lines, merges repeats, and stores totals from the pipeline', async () => {
    const { id } = await newCart();
    await carts.addLine(id, { variantId: 'var_a', quantity: 1 });
    await carts.addLine(id, { variantId: 'var_b', quantity: 1 });
    const result = await carts.addLine(id, { variantId: 'var_a', quantity: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const cart = result.value;
    expect(cart.lines.map((l) => [l.variantId, l.quantity, l.subtotal.amount, l.productTitle])).toEqual([
      ['var_a', 3, 3000, 'P var_a'],
      ['var_b', 1, 2500, 'P var_b'],
    ]);
    expect(cart.subtotal).toEqual(money(5500, 'EUR'));
    expect(cart.adjustments).toEqual([
      { kind: 'promotion', label: '5 off', amount: money(-500, 'EUR'), target: { type: 'order' }, source: 'test.order-discount' },
    ]);
    expect(cart.total).toEqual(money(5000, 'EUR'));
    expect(await carts.getCart(id)).toEqual(cart);
  });

  it('re-prices every line on each change, applying quantity tiers', async () => {
    const { id } = await newCart();
    const added = await carts.addLine(id, { variantId: 'var_a', quantity: 1 });
    const lineId = added.ok ? added.value.lines[0]!.id : '';

    tiers.set('var_a', { from: 10, amount: 800 });
    const bulk = await carts.updateLineQuantity(id, lineId, 10);
    expect(bulk.ok && bulk.value.lines[0]!.unitPrice).toEqual(money(800, 'EUR'));

    prices.set('var_b', 2000);
    const both = await carts.addLine(id, { variantId: 'var_b', quantity: 1 });
    expect(both.ok && both.value.subtotal).toEqual(money(10_000, 'EUR'));
  });

  it('keeps lines that stop being sellable, outside the totals', async () => {
    const { id } = await newCart();
    await carts.addLine(id, { variantId: 'var_a', quantity: 1 });
    forSale.delete('var_a');
    const result = await carts.addLine(id, { variantId: 'var_b', quantity: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines.map((l) => [l.variantId, l.available])).toEqual([
      ['var_a', false],
      ['var_b', true],
    ]);
    expect(result.value.total).toEqual(money(2500, 'EUR'));
  });

  it('refuses unsellable or unpriced variants without changing the cart', async () => {
    const { id } = await newCart();
    await carts.addLine(id, { variantId: 'var_a', quantity: 1 });
    expect(await carts.addLine(id, { variantId: 'var_x', quantity: 1 })).toMatchObject({
      ok: false,
      error: { code: 'variant_not_available' },
    });
    forSale.add('var_c');
    expect(await carts.addLine(id, { variantId: 'var_c', quantity: 1 })).toMatchObject({
      ok: false,
      error: { code: 'variant_not_priced' },
    });
    expect((await carts.getCart(id))!.lines).toHaveLength(1);
  });

  it('updates and removes lines, reporting missing carts and lines', async () => {
    const { id } = await newCart();
    const added = await carts.addLine(id, { variantId: 'var_a', quantity: 2 });
    const lineId = added.ok ? added.value.lines[0]!.id : '';

    expect(await carts.updateLineQuantity(id, 'line_x', 1)).toMatchObject({ ok: false, error: { code: 'line_not_found' } });
    expect(await carts.updateLineQuantity('cart_x', lineId, 1)).toMatchObject({ ok: false, error: { code: 'cart_not_found' } });

    const removed = await carts.removeLine(id, lineId);
    expect(removed).toMatchObject({ ok: true, value: { lines: [], total: money(0, 'EUR') } });
  });

  it('serializes concurrent changes to the same cart', async () => {
    const { id } = await newCart();
    await Promise.all(Array.from({ length: 5 }, () => carts.addLine(id, { variantId: 'var_a', quantity: 1 })));
    const cart = (await carts.getCart(id))!;
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]!.quantity).toBe(5);
  });

  describe('checkout', () => {
    const address = { firstName: 'Ada', lastName: 'Lovelace', line1: '1 Main St', city: 'Berlin', postalCode: '10115', country: 'DE' };

    async function cartWithLine() {
      const { id } = await newCart();
      await carts.addLine(id, { variantId: 'var_a', quantity: 2 });
      return id;
    }

    it('collects addresses, then a shipping method that becomes an adjustment', async () => {
      const id = await cartWithLine();
      const addressed = await carts.setAddresses(id, { email: 'Ada@Example.com', shippingAddress: address });
      expect(addressed).toMatchObject({
        ok: true,
        value: { checkoutState: 'addressed', email: 'ada@example.com', shippingAddress: { city: 'Berlin', company: null } },
      });

      const options = await carts.listShippingOptions(id);
      expect(options.ok && options.value.map((o) => o.optionId)).toEqual(['ship_std', 'ship_exp']);

      const shipped = await carts.selectShippingOption(id, 'ship_exp');
      expect(shipped.ok).toBe(true);
      if (!shipped.ok) return;
      expect(shipped.value).toMatchObject({
        checkoutState: 'shipping_selected',
        shippingMethod: { optionId: 'ship_exp', name: 'Express', amount: money(1500, 'EUR') },
        subtotal: money(2000, 'EUR'),
        total: money(3500, 'EUR'),
      });
      expect(shipped.value.adjustments).toEqual([
        { kind: 'shipping', label: 'Express', amount: money(1500, 'EUR'), target: { type: 'order' }, source: 'core.shipping' },
      ]);
      expect(await carts.getCart(id)).toEqual(shipped.value);
    });

    it('enforces the step order and refuses options that do not apply', async () => {
      const id = await cartWithLine();
      expect(await carts.listShippingOptions(id)).toMatchObject({ ok: false, error: { code: 'address_required' } });
      expect(await carts.selectShippingOption(id, 'ship_std')).toMatchObject({ ok: false, error: { code: 'address_required' } });

      await carts.setAddresses(id, { email: 'a@b.co', shippingAddress: { ...address, country: 'FR' } });
      expect(await carts.selectShippingOption(id, 'ship_exp')).toMatchObject({
        ok: false,
        error: { code: 'shipping_option_unavailable' },
      });
      expect((await carts.getCart(id))!.checkoutState).toBe('addressed');

      const empty = (await newCart()).id;
      expect(await carts.setAddresses(empty, { email: 'a@b.co', shippingAddress: address })).toMatchObject({
        ok: false,
        error: { code: 'cart_empty' },
      });
    });

    it('drops the shipping method when the address moves somewhere it does not ship', async () => {
      const id = await cartWithLine();
      await carts.setAddresses(id, { email: 'a@b.co', shippingAddress: address });
      await carts.selectShippingOption(id, 'ship_exp');

      const moved = await carts.setAddresses(id, { email: 'a@b.co', shippingAddress: { ...address, country: 'FR' } });
      expect(moved).toMatchObject({ ok: true, value: { checkoutState: 'addressed', shippingMethod: null, total: money(2000, 'EUR') } });
    });

    it('re-prices shipping on every change, and falls back when the option disappears', async () => {
      const id = await cartWithLine();
      await carts.setAddresses(id, { email: 'a@b.co', shippingAddress: address });
      const shipped = await carts.selectShippingOption(id, 'ship_std');
      const lineId = shipped.ok ? shipped.value.lines[0]!.id : '';

      shippingOptions.set('ship_std', { name: 'Standard', amount: 595, countries: ['DE'] });
      const repriced = await carts.updateLineQuantity(id, lineId, 3);
      expect(repriced.ok && repriced.value.total).toEqual(money(3595, 'EUR'));

      shippingOptions.delete('ship_std');
      const dropped = await carts.updateLineQuantity(id, lineId, 4);
      expect(dropped).toMatchObject({ ok: true, value: { checkoutState: 'addressed', shippingMethod: null, total: money(4000, 'EUR') } });
    });

    async function readyForPayment() {
      const id = await cartWithLine();
      await carts.setAddresses(id, { email: 'a@b.co', shippingAddress: address });
      const shipped = await carts.selectShippingOption(id, 'ship_std');
      if (!shipped.ok) throw new Error(shipped.error.message);
      return { id, lineId: shipped.value.lines[0]!.id };
    }

    it('prepares a payment for the cart total and moves to payment_selected', async () => {
      const { id } = await readyForPayment();
      expect(await carts.listPaymentMethods(id)).toEqual({ ok: true, value: [{ providerId: 'test', name: 'Test payments' }] });

      const paid = await carts.selectPaymentMethod(id, { providerId: 'test', data: { outcome: 'decline' } });
      expect(paid).toMatchObject({
        ok: true,
        value: {
          checkoutState: 'payment_selected',
          total: money(2495, 'EUR'),
          paymentMethod: { providerId: 'test', name: 'Test payments', amount: money(2495, 'EUR'), clientData: { ready: true } },
        },
      });
      expect(sessions.at(-1)).toEqual({ providerId: 'test', amount: 2495 });
      expect((await carts.getCart(id))!.paymentMethod?.sessionId).toBe(paid.ok && paid.value.paymentMethod?.sessionId);
    });

    it('needs shipping first and refuses methods the channel does not offer', async () => {
      const id = await cartWithLine();
      expect(await carts.selectPaymentMethod(id, { providerId: 'test' })).toMatchObject({
        ok: false,
        error: { code: 'shipping_required' },
      });
      const ready = await readyForPayment();
      expect(await carts.selectPaymentMethod(ready.id, { providerId: 'stripe' })).toMatchObject({
        ok: false,
        error: { code: 'payment_method_unavailable' },
      });
      expect((await carts.getCart(ready.id))!.checkoutState).toBe('shipping_selected');
    });

    it('drops the payment when the total changes, and keeps it when it does not', async () => {
      const { id, lineId } = await readyForPayment();
      await carts.selectPaymentMethod(id, { providerId: 'test' });

      const sameTotal = await carts.updateLineQuantity(id, lineId, 2);
      expect(sameTotal).toMatchObject({ ok: true, value: { checkoutState: 'payment_selected' } });

      const changed = await carts.updateLineQuantity(id, lineId, 3);
      expect(changed).toMatchObject({ ok: true, value: { checkoutState: 'shipping_selected', paymentMethod: null } });
    });

    it('refuses to save a payment prepared for a cart that changed meanwhile', async () => {
      const { id, lineId } = await readyForPayment();
      duringSession = async () => {
        await carts.updateLineQuantity(id, lineId, 5);
      };
      try {
        expect(await carts.selectPaymentMethod(id, { providerId: 'test' })).toMatchObject({
          ok: false,
          error: { code: 'cart_changed' },
        });
      } finally {
        duringSession = async () => {};
      }
      expect((await carts.getCart(id))!).toMatchObject({ checkoutState: 'shipping_selected', paymentMethod: null });

      // Simply choosing again works, for the new total (5 x 10.00, less the 5.00 discount, plus 4.95 shipping).
      const retried = await carts.selectPaymentMethod(id, { providerId: 'test' });
      expect(retried.ok && retried.value.paymentMethod?.amount).toEqual(money(4995, 'EUR'));
    });

    describe('completion', () => {
      async function readyToComplete() {
        const ready = await readyForPayment();
        const paid = await carts.selectPaymentMethod(ready.id, { providerId: 'test' });
        if (!paid.ok) throw new Error(paid.error.message);
        return ready;
      }

      it('re-validates and freezes the cart under the completion key', async () => {
        const { id } = await readyToComplete();
        const begun = await carts.beginCompletion(id, 'key-1');
        expect(begun).toMatchObject({ ok: true, value: { checkoutState: 'completing', total: money(2495, 'EUR') } });
        const row = await sql<{ completion_key: string; completion_started_at: Date | null }>`
          select completion_key, completion_started_at from cart where id = ${id}`.execute(t.db);
        expect(row.rows[0]).toMatchObject({ completion_key: 'key-1', completion_started_at: expect.any(Date) });

        expect(await carts.beginCompletion(id, 'key-2')).toMatchObject({ ok: false, error: { code: 'completion_in_progress' } });
        expect(await carts.addLine(id, { variantId: 'var_b', quantity: 1 })).toMatchObject({ ok: false, error: { code: 'cart_locked' } });
      });

      it('needs a payment method first', async () => {
        const { id } = await readyForPayment();
        expect(await carts.beginCompletion(id, 'k')).toMatchObject({ ok: false, error: { code: 'payment_required' } });
      });

      it('saves new prices and refuses when the total changed since the payment was prepared', async () => {
        const { id } = await readyToComplete();
        prices.set('var_a', 1200);
        expect(await carts.beginCompletion(id, 'k')).toMatchObject({ ok: false, error: { code: 'cart_changed' } });
        expect((await carts.getCart(id))!).toMatchObject({
          checkoutState: 'shipping_selected',
          paymentMethod: null,
          total: money(2895, 'EUR'),
        });
      });

      it('releases a completing cart, keeping the payment only when asked', async () => {
        const kept = await readyToComplete();
        await carts.beginCompletion(kept.id, 'k');
        expect(await carts.abortCompletion(kept.id, { keepPayment: true })).toMatchObject({
          ok: true,
          value: { checkoutState: 'payment_selected', paymentMethod: { providerId: 'test' } },
        });

        const dropped = await readyToComplete();
        await carts.beginCompletion(dropped.id, 'k');
        expect(await carts.abortCompletion(dropped.id, { keepPayment: false })).toMatchObject({
          ok: true,
          value: { checkoutState: 'shipping_selected', paymentMethod: null },
        });
        // Releasing a cart that is not completing changes nothing.
        expect(await carts.abortCompletion(dropped.id, { keepPayment: false })).toMatchObject({
          ok: true,
          value: { checkoutState: 'shipping_selected' },
        });
      });

      it('marks a completing cart placed, once', async () => {
        const { id } = await readyToComplete();
        expect(await carts.markPlaced(id, 'ord_1')).toMatchObject({ ok: false, error: { code: 'cart_not_completing' } });
        await carts.beginCompletion(id, 'k');
        expect(await carts.markPlaced(id, 'ord_1')).toMatchObject({ ok: true, value: { checkoutState: 'placed', orderId: 'ord_1' } });
        expect(await carts.markPlaced(id, 'ord_1')).toMatchObject({ ok: true, value: { checkoutState: 'placed' } });
        expect(await carts.selectShippingOption(id, 'ship_std')).toMatchObject({ ok: false, error: { code: 'cart_locked' } });
      });

      it('finds completions abandoned before a cutoff', async () => {
        const { id } = await readyToComplete();
        await carts.beginCompletion(id, 'k');
        expect((await carts.staleCompletions(new Date(Date.now() - 60_000))).map((c) => c.id)).not.toContain(id);
        await sql`update cart set completion_started_at = now() - interval '10 minutes' where id = ${id}`.execute(t.db);
        expect((await carts.staleCompletions(new Date(Date.now() - 60_000))).map((c) => c.id)).toContain(id);
      });
    });

    it('freezes a cart once completion starts', async () => {
      const id = await cartWithLine();
      await sql`update cart set checkout_state = 'completing', completion_key = 'k', completion_started_at = now() where id = ${id}`.execute(t.db);
      expect(await carts.addLine(id, { variantId: 'var_b', quantity: 1 })).toMatchObject({ ok: false, error: { code: 'cart_locked' } });
      expect(await carts.setAddresses(id, { email: 'a@b.co', shippingAddress: address })).toMatchObject({
        ok: false,
        error: { code: 'cart_locked' },
      });
    });
  });

  it('records cart events', async () => {
    const rows = await sql<{ topic: string }>`select distinct topic from outbox_event order by topic`.execute(t.db);
    expect(rows.rows.map((r) => r.topic)).toEqual(['cart.created', 'cart.updated']);
  });
});
