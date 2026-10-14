import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money } from '../../kernel/money.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../testing/postgres.js';
import { ordersModule, type ListOrdersQuery, type OrderService, type PlaceOrderInput } from './index.js';

const eur = (amount: number) => money(amount, 'EUR');
const address = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  company: null,
  line1: '1 Main St',
  line2: null,
  city: 'Berlin',
  postalCode: '10115',
  region: null,
  country: 'DE',
  phone: null,
};

function input(cartId: string): PlaceOrderInput {
  return {
    cartId,
    channelId: 'chn_eu',
    currency: 'EUR',
    email: 'ada@example.com',
    shippingAddress: address,
    billingAddress: { ...address, line1: '2 Billing Rd' },
    shippingMethod: { optionId: 'ship_1', name: 'Standard', amount: eur(495) },
    lines: [
      {
        cartLineId: 'line_a',
        variantId: 'var_a',
        productId: 'prod_a',
        productHandle: 'tee',
        productTitle: 'T-shirt',
        variantTitle: 'S',
        sku: 'TEE-S',
        quantity: 2,
        unitPrice: eur(1500),
        originalUnitPrice: eur(2000),
        subtotal: eur(3000),
        total: eur(2700),
      },
    ],
    subtotal: eur(3000),
    adjustments: [
      { kind: 'promotion', label: '10% off', amount: eur(-300), target: { type: 'line', lineId: 'line_a' }, source: 'promo' },
      { kind: 'shipping', label: 'Standard', amount: eur(495), target: { type: 'order' }, source: 'core.shipping' },
    ],
    adjustmentsTotal: eur(195),
    total: eur(3195),
    payment: { providerId: 'test', sessionId: 'pays_1' },
  };
}

describe.skipIf(!TEST_DATABASE_URL)('order service (Postgres)', () => {
  let t: TestDatabase;
  let orders: OrderService;

  beforeAll(async () => {
    t = await createTestDatabase();
    orders = ordersModule.createService(t.db);
  });
  afterAll(() => t?.destroy());

  it('places an order as a full copy of the cart, with a sequential number', async () => {
    const result = await orders.placeOrder(input('cart_1'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const order = result.value;
    expect(order).toMatchObject({
      number: 1001,
      cartId: 'cart_1',
      status: 'placed',
      email: 'ada@example.com',
      billingAddress: { line1: '2 Billing Rd' },
      shippingMethod: { name: 'Standard', amount: eur(495) },
      total: eur(3195),
      payment: { providerId: 'test', sessionId: 'pays_1' },
    });
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]).toMatchObject({ productTitle: 'T-shirt', quantity: 2, unitPrice: eur(1500), originalUnitPrice: eur(2000) });

    // Line adjustments now point at the order's own line.
    expect(order.adjustments[0]!.target).toEqual({ type: 'line', lineId: order.lines[0]!.id });
    expect(order.adjustments[1]!.target).toEqual({ type: 'order' });

    expect(await orders.getOrder(order.id)).toEqual(order);
    expect(await orders.getOrderByCart('cart_1')).toEqual(order);
  });

  it('is idempotent per cart: placing again returns the same order and records one event', async () => {
    const again = await orders.placeOrder({ ...input('cart_1'), email: 'someone@else.com' });
    expect(again).toMatchObject({ ok: true, value: { number: 1001, email: 'ada@example.com' } });
    const events = await sql<{ topic: string }>`select topic from outbox_event where topic = 'order.placed'`.execute(t.db);
    expect(events.rows).toHaveLength(1);
  });

  it('places concurrent attempts for one cart exactly once', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => orders.placeOrder(input('cart_race'))));
    const ids = new Set(results.map((r) => (r.ok ? r.value.id : 'error')));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^ord_/);
  });

  it('validates the input', async () => {
    expect(await orders.placeOrder({ ...input('cart_x'), lines: [] })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await orders.placeOrder({ ...input('cart_x'), total: money(1, 'USD') })).toMatchObject({ ok: false });
  });

  const list = async (query: ListOrdersQuery) => {
    const result = await orders.listOrders(query);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };

  it('lists orders newest first, by channel', async () => {
    await orders.placeOrder({ ...input('cart_us'), channelId: 'chn_us' });
    const eu = await list({ channelId: 'chn_eu', limit: 1 });
    expect(eu.items.map((o) => o.cartId)).toEqual(['cart_race']);
    expect(eu.nextCursor).not.toBeNull();
    const next = await list({ channelId: 'chn_eu', limit: 10, after: eu.nextCursor! });
    expect(next.items.map((o) => o.cartId)).toEqual(['cart_1']);
    expect((await list({ limit: 10 })).items).toHaveLength(3);
  });

  it('rejects a cursor it did not hand out, instead of starting over', async () => {
    for (const after of ['x', 'ord_1', 'prod_01a116a9fef8ea0a84798e935e441f42']) {
      expect(await orders.listOrders({ limit: 10, after })).toMatchObject({ ok: false, error: { code: 'invalid_cursor' } });
    }
  });
});
