import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, type Core } from './core.js';
import { money } from './kernel/money.js';
import { testPaymentProvider } from './modules/payments/index.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from './testing/postgres.js';

/** The first purchase, end to end through the real modules, wired as in production (ADR 0018). */
describe.skipIf(!TEST_DATABASE_URL)('placing an order (Postgres)', () => {
  let t: TestDatabase;
  let core: Core;
  let channelId: string;
  let variantId: string;
  let optionId: string;

  const address = { firstName: 'Ada', lastName: 'Lovelace', line1: '1 Main St', city: 'Berlin', postalCode: '10115', country: 'DE' };

  beforeAll(async () => {
    t = await createTestDatabase();
    core = createCore(t.db, { paymentProviders: [testPaymentProvider()] });
    const channel = await core.channel.create({ code: 'eu', name: 'EU', defaultCurrency: 'EUR', defaultLocale: 'en' });
    if (!channel.ok) throw new Error('channel');
    channelId = channel.value.id;

    const product = await core.catalog.createProduct({ handle: 'lamp', title: 'Lamp', status: 'published' });
    if (!product.ok) throw new Error('product');
    variantId = product.value.variants[0]!.id;
    await core.catalog.setProductChannels(product.value.id, [channelId]);
    await core.pricing.setVariantPrices(variantId, [{ currency: 'EUR', amount: 4000 }]);
    const option = await core.shipping.createOption({ channelId, name: 'Standard', prices: [{ currency: 'EUR', amount: 495 }] });
    if (!option.ok) throw new Error('shipping');
    optionId = option.value.id;
    await core.payments.setProviderChannels('test', [{ channelId }]);
  });
  afterAll(() => t?.destroy());

  const ledger = async (sessionId: string) =>
    (await core.payments.listTransactions(sessionId)).map((tx) => `${tx.kind}:${tx.status}:${tx.amount.amount}`);

  /** A cart at the payment step, paid with the test provider and the given outcome. */
  async function readyCart(outcome?: string) {
    const cart = await core.cart.createCart({ channelId, currency: 'EUR' });
    if (!cart.ok) throw new Error('cart');
    const id = cart.value.id;
    await core.cart.addLine(id, { variantId, quantity: 2 });
    await core.cart.setAddresses(id, { email: 'ada@example.com', shippingAddress: address });
    await core.cart.selectShippingOption(id, optionId);
    const paid = await core.cart.selectPaymentMethod(id, { providerId: 'test', data: outcome ? { outcome } : {} });
    if (!paid.ok) throw new Error(paid.error.message);
    return paid.value;
  }

  it('places the order, authorizes and captures the payment, and closes the cart', async () => {
    const cart = await readyCart();
    const result = await core.checkout.completeCart(cart.id, 'attempt-1');
    expect(result).toMatchObject({ ok: true, value: { replayed: false } });
    if (!result.ok) return;

    const order = (await core.orders.getOrder(result.value.orderId))!;
    expect(order).toMatchObject({
      cartId: cart.id,
      channelId,
      status: 'placed',
      email: 'ada@example.com',
      total: money(8495, 'EUR'),
      shippingMethod: { name: 'Standard', amount: money(495, 'EUR') },
      payment: { providerId: 'test', sessionId: cart.paymentMethod!.sessionId },
    });
    expect(order.lines.map((l) => [l.productTitle, l.quantity, l.total.amount])).toEqual([['Lamp', 2, 8000]]);

    expect(await core.cart.getCart(cart.id)).toMatchObject({ checkoutState: 'placed', orderId: order.id });
    expect(await core.payments.getSession(cart.paymentMethod!.sessionId)).toMatchObject({
      status: 'captured',
      capturedAmount: money(8495, 'EUR'),
    });
    expect(await ledger(cart.paymentMethod!.sessionId)).toEqual(['authorize:succeeded:8495', 'capture:succeeded:8495']);
  });

  it('returns the same order on a retry, with any key, without charging again', async () => {
    const cart = await readyCart();
    const first = await core.checkout.completeCart(cart.id, 'attempt-1');
    const retry = await core.checkout.completeCart(cart.id, 'attempt-2');
    expect(retry).toEqual({ ok: true, value: { orderId: first.ok ? first.value.orderId : '', replayed: true } });
    expect(await ledger(cart.paymentMethod!.sessionId)).toEqual(['authorize:succeeded:8495', 'capture:succeeded:8495']);
  });

  it('places concurrent attempts exactly once', async () => {
    const cart = await readyCart();
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => core.checkout.completeCart(cart.id, `race-${i}`)));
    const placed = results.filter((r) => r.ok);
    const orderIds = new Set(placed.map((r) => (r.ok ? r.value.orderId : '')));
    expect(orderIds.size).toBe(1);
    for (const r of results) if (!r.ok) expect(r.error.code).toBe('completion_in_progress');
    const orders = await sql<{ n: string }>`select count(*) as n from sales_order where cart_id = ${cart.id}`.execute(t.db);
    expect(Number(orders.rows[0]!.n)).toBe(1);
    expect(await ledger(cart.paymentMethod!.sessionId)).toEqual(['authorize:succeeded:8495', 'capture:succeeded:8495']);
  });

  it('only authorizes where the channel captures manually', async () => {
    await core.payments.setProviderChannels('test', [{ channelId, captureMode: 'manual' }]);
    try {
      const cart = await readyCart();
      expect(await core.checkout.completeCart(cart.id, 'k')).toMatchObject({ ok: true });
      expect(await core.payments.getSession(cart.paymentMethod!.sessionId)).toMatchObject({ status: 'authorized', captureMode: 'manual' });
      expect(await core.checkout.captureDue(new Date(Date.now() + 60_000))).toBe(0);
    } finally {
      await core.payments.setProviderChannels('test', [{ channelId }]);
    }
  });

  it('keeps the order when the capture is declined, and does not retry it', async () => {
    const cart = await readyCart('capture_decline');
    const result = await core.checkout.completeCart(cart.id, 'k');
    expect(result).toMatchObject({ ok: true, value: { replayed: false } });
    expect(await core.cart.getCart(cart.id)).toMatchObject({ checkoutState: 'placed' });
    expect(await core.payments.getSession(cart.paymentMethod!.sessionId)).toMatchObject({ status: 'authorized' });
    expect(await ledger(cart.paymentMethod!.sessionId)).toEqual(['authorize:succeeded:8495', 'capture:failed:8495']);
    const sessions = await core.payments.sessionsAwaitingCapture(new Date(Date.now() + 60_000));
    expect(sessions.map((s) => s.id)).not.toContain(cart.paymentMethod!.sessionId);
  });

  it('captures later when the process died before capturing', async () => {
    const cart = await readyCart();
    await core.checkout.completeCart(cart.id, 'k');
    const sessionId = cart.paymentMethod!.sessionId;
    // Undo the capture, as if the process had died between finishing and capturing.
    await sql`delete from payment_transaction where session_id = ${sessionId} and kind = 'capture'`.execute(t.db);
    await sql`update payment_session set status = 'authorized', captured_amount = 0 where id = ${sessionId}`.execute(t.db);

    expect(await core.checkout.captureDue(new Date(Date.now() - 60_000))).toBe(0);
    expect(await core.checkout.captureDue(new Date(Date.now() + 60_000))).toBeGreaterThanOrEqual(1);
    expect(await core.payments.getSession(sessionId)).toMatchObject({ status: 'captured' });
  });

  it('sends a declined cart back to the payment step, and a new method succeeds', async () => {
    const cart = await readyCart('decline');
    expect(await core.checkout.completeCart(cart.id, 'k1')).toMatchObject({ ok: false, error: { code: 'payment_declined' } });
    expect(await core.cart.getCart(cart.id)).toMatchObject({ checkoutState: 'shipping_selected', paymentMethod: null });
    expect(await core.orders.getOrderByCart(cart.id)).toBeUndefined();

    await core.cart.selectPaymentMethod(cart.id, { providerId: 'test' });
    expect(await core.checkout.completeCart(cart.id, 'k2')).toMatchObject({ ok: true });
  });

  it('keeps the payment when the shopper must act, so they can retry', async () => {
    const cart = await readyCart('requires_action');
    const result = await core.checkout.completeCart(cart.id, 'k1');
    expect(result).toMatchObject({ ok: false, error: { code: 'payment_requires_action', details: { clientData: { action: 'confirm' } } } });
    expect(await core.cart.getCart(cart.id)).toMatchObject({ checkoutState: 'payment_selected', paymentMethod: { providerId: 'test' } });
  });

  it('refuses to place an order at prices the shopper did not see', async () => {
    const cart = await readyCart();
    await core.pricing.setVariantPrices(variantId, [{ currency: 'EUR', amount: 4500 }]);
    try {
      expect(await core.checkout.completeCart(cart.id, 'k')).toMatchObject({ ok: false, error: { code: 'cart_changed' } });
      expect(await core.cart.getCart(cart.id)).toMatchObject({ checkoutState: 'shipping_selected', total: money(9495, 'EUR') });
      expect(await core.payments.listTransactions(cart.paymentMethod!.sessionId)).toEqual([]);
    } finally {
      await core.pricing.setVariantPrices(variantId, [{ currency: 'EUR', amount: 4000 }]);
    }
  });

  it('recovers a completion abandoned after authorizing: cancels the payment and releases the cart', async () => {
    const cart = await readyCart();
    // Simulate a crash after steps 1 and 2.
    await core.cart.beginCompletion(cart.id, 'crashed');
    await core.payments.authorizeSession({ sessionId: cart.paymentMethod!.sessionId, amount: cart.total, idempotencyKey: 'x' });
    expect(await core.checkout.completeCart(cart.id, 'retry')).toMatchObject({ ok: false, error: { code: 'completion_in_progress' } });

    await sql`update cart set completion_started_at = now() - interval '10 minutes' where id = ${cart.id}`.execute(t.db);
    expect(await core.checkout.recoverStale(new Date(Date.now() - 5 * 60_000))).toBe(1);
    expect(await core.payments.getSession(cart.paymentMethod!.sessionId)).toMatchObject({ status: 'canceled' });
    expect(await core.cart.getCart(cart.id)).toMatchObject({ checkoutState: 'shipping_selected', paymentMethod: null });
  });

  it('records the order.placed event in the outbox', async () => {
    const events = await sql<{ n: string }>`select count(*) as n from outbox_event where topic = 'order.placed'`.execute(t.db);
    expect(Number(events.rows[0]!.n)).toBeGreaterThanOrEqual(4);
  });
});
