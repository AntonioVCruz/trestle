import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money } from '../../kernel/money.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../testing/postgres.js';
import { MAX_AUTOMATIC_CAPTURE_ATTEMPTS, paymentsModule, type PaymentProvider, type PaymentsService } from './index.js';
import { PAYMENT_PROVIDER_CONTRACT_VERSION } from './provider.js';
import { testPaymentProvider } from './test-provider.js';

/** A provider whose initiate call fails, as a gateway outage would. */
const brokenProvider: PaymentProvider = {
  ...testPaymentProvider(),
  id: 'broken',
  name: 'Broken',
  contractVersion: PAYMENT_PROVIDER_CONTRACT_VERSION,
  initiate: async () => {
    throw new Error('gateway timeout');
  },
};

/** Prepares fine, but its gateway fails on authorize, cancel and capture. */
const flakyProvider: PaymentProvider = {
  ...testPaymentProvider(),
  id: 'flaky',
  name: 'Flaky',
  supportsDeferredCapture: false,
  testMode: false,
  authorize: async () => {
    throw new Error('connection reset');
  },
  cancel: async () => {
    throw new Error('connection reset');
  },
  capture: async () => {
    throw new Error('connection reset');
  },
};

const on = (...channelIds: string[]) => channelIds.map((channelId) => ({ channelId }));

describe.skipIf(!TEST_DATABASE_URL)('payments service (Postgres)', () => {
  let t: TestDatabase;
  let payments: PaymentsService;

  beforeAll(async () => {
    t = await createTestDatabase();
    payments = paymentsModule.createService(t.db, { providers: [testPaymentProvider(), brokenProvider, flakyProvider] });
  });
  afterAll(() => t?.destroy());

  const session = { cartId: 'cart_1', channelId: 'chn_eu', providerId: 'test', amount: money(2495, 'EUR'), email: 'a@b.co' };

  it('refuses duplicate or incompatible providers at startup', () => {
    expect(() => paymentsModule.createService(t.db, { providers: [testPaymentProvider(), testPaymentProvider()] })).toThrow(
      /registered twice/,
    );
    expect(() =>
      paymentsModule.createService(t.db, { providers: [{ ...testPaymentProvider(), contractVersion: '2.0.0' }] }),
    ).toThrow(/contract/);
  });

  it('offers a provider only in the channels it is enabled for', async () => {
    expect(await payments.availableMethods('chn_eu')).toEqual([]);
    expect((await payments.listProviders()).map((p) => [p.id, p.channels])).toEqual([
      ['test', []],
      ['broken', []],
      ['flaky', []],
    ]);

    expect(
      await payments.setProviderChannels('test', [{ channelId: 'chn_us', captureMode: 'manual' }, { channelId: 'chn_eu' }]),
    ).toEqual({
      ok: true,
      value: {
        id: 'test',
        name: 'Test payments',
        supportsDeferredCapture: true,
        testMode: true,
        channels: [
          { channelId: 'chn_eu', captureMode: 'immediate' },
          { channelId: 'chn_us', captureMode: 'manual' },
        ],
      },
    });
    expect((await payments.listProviders())[0]!.channels).toHaveLength(2);
    expect(await payments.availableMethods('chn_eu')).toEqual([{ providerId: 'test', name: 'Test payments' }]);
    expect(await payments.setProviderChannels('stripe', on('chn_eu'))).toMatchObject({
      ok: false,
      error: { code: 'payment_provider_not_found' },
    });
    expect(await payments.setProviderChannels('test', on('chn_eu', 'chn_eu'))).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  });

  it('allows manual capture only for providers that support it', async () => {
    expect(await payments.setProviderChannels('flaky', [{ channelId: 'chn_eu', captureMode: 'manual' }])).toMatchObject({
      ok: false,
      error: { code: 'deferred_capture_unsupported' },
    });
    expect((await payments.listProviders()).find((p) => p.id === 'flaky')).toMatchObject({
      supportsDeferredCapture: false,
      testMode: false,
      channels: [],
    });
  });

  it('reports channels that enable a provider this deployment no longer registers', async () => {
    const without = paymentsModule.createService(t.db, { providers: [brokenProvider, flakyProvider] });
    expect(await without.unregisteredProviders()).toEqual([{ providerId: 'test', channelIds: ['chn_eu', 'chn_us'] }]);
    expect(await without.availableMethods('chn_eu')).toEqual([]);
    expect(await payments.unregisteredProviders()).toEqual([]);
  });

  it('starts a session with the provider and stores its reference and client data', async () => {
    const result = await payments.startSession({ ...session, data: { outcome: 'decline' } });
    expect(result).toMatchObject({
      ok: true,
      value: {
        cartId: 'cart_1',
        providerId: 'test',
        providerName: 'Test payments',
        amount: money(2495, 'EUR'),
        status: 'pending',
        reference: expect.stringMatching(/^test_pays_/),
        data: { outcome: 'decline' },
        clientData: { outcome: 'decline' },
      },
    });
    if (result.ok) expect(await payments.getSession(result.value.id)).toEqual(result.value);
  });

  it('refuses providers the channel does not offer, and oversized data', async () => {
    for (const input of [
      { ...session, providerId: 'stripe' },
      { ...session, providerId: 'broken' },
      { ...session, channelId: 'chn_other' },
    ]) {
      expect(await payments.startSession({ ...input, data: {} })).toMatchObject({
        ok: false,
        error: { code: 'payment_method_unavailable' },
      });
    }
    expect(await payments.startSession({ ...session, data: { blob: 'x'.repeat(5000) } })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  });

  it('marks a session failed when the provider errors', async () => {
    await payments.setProviderChannels('broken', on('chn_eu'));
    const result = await payments.startSession({ ...session, providerId: 'broken', data: {} });
    expect(result).toMatchObject({ ok: false, error: { code: 'payment_initiation_failed', message: /gateway timeout/ } });
    const rows = await sql<{ status: string }>`select status from payment_session where provider_id = 'broken'`.execute(t.db);
    expect(rows.rows).toEqual([{ status: 'failed' }]);
  });

  describe('authorization', () => {
    async function start(data: Record<string, unknown> = {}, providerId = 'test') {
      await payments.setProviderChannels(providerId, on('chn_eu'));
      const result = await payments.startSession({ ...session, providerId, data });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    }
    const kinds = async (id: string) => (await payments.listTransactions(id)).map((tx) => `${tx.kind}:${tx.status}`);

    it('authorizes, records the ledger entry, and treats a repeat as a no-op', async () => {
      const { id } = await start();
      const authorized = await payments.authorizeSession({ sessionId: id, amount: money(2495, 'EUR'), idempotencyKey: 'k1' });
      expect(authorized).toMatchObject({
        ok: true,
        value: { status: 'authorized', reference: `test_${id}`, captureMode: 'immediate', authorizationExpiresAt: expect.any(Date) },
      });
      const again = await payments.authorizeSession({ sessionId: id, amount: money(2495, 'EUR'), idempotencyKey: 'k1' });
      expect(again).toMatchObject({ ok: true, value: { status: 'authorized' } });
      expect(await kinds(id)).toEqual(['authorize:succeeded']);
    });

    it('refuses a different amount without calling the provider', async () => {
      const { id } = await start();
      expect(await payments.authorizeSession({ sessionId: id, amount: money(1, 'EUR'), idempotencyKey: 'k' })).toMatchObject({
        ok: false,
        error: { code: 'payment_amount_mismatch' },
      });
      expect(await kinds(id)).toEqual([]);
    });

    it('marks declined sessions failed and unusable', async () => {
      const { id } = await start({ outcome: 'decline' });
      expect(await payments.authorizeSession({ sessionId: id, amount: money(2495, 'EUR'), idempotencyKey: 'k' })).toMatchObject({
        ok: false,
        error: { code: 'payment_declined' },
      });
      expect((await payments.getSession(id))!.status).toBe('failed');
      expect(await payments.authorizeSession({ sessionId: id, amount: money(2495, 'EUR'), idempotencyKey: 'k' })).toMatchObject({
        ok: false,
        error: { code: 'payment_session_unusable' },
      });
      expect(await kinds(id)).toEqual(['authorize:failed']);
    });

    it('returns the provider’s client data when the shopper must act', async () => {
      const { id } = await start({ outcome: 'requires_action' });
      const result = await payments.authorizeSession({ sessionId: id, amount: money(2495, 'EUR'), idempotencyKey: 'k' });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'payment_requires_action', details: { clientData: { action: 'confirm' } } },
      });
      expect((await payments.getSession(id))!).toMatchObject({ status: 'requires_action', clientData: { action: 'confirm' } });
    });

    it('records a provider outage and leaves the session usable', async () => {
      const { id } = await start({}, 'flaky');
      expect(await payments.authorizeSession({ sessionId: id, amount: money(2495, 'EUR'), idempotencyKey: 'k' })).toMatchObject({
        ok: false,
        error: { code: 'payment_provider_failed', message: /connection reset/ },
      });
      expect((await payments.getSession(id))!.status).toBe('pending');
      expect(await kinds(id)).toEqual(['authorize:error']);
    });

    it('cancels authorizations, and reports when it cannot', async () => {
      const { id } = await start();
      expect((await payments.cancelAuthorization(id, 'c0')).ok).toBe(true);
      expect(await kinds(id)).toEqual([]);

      await payments.authorizeSession({ sessionId: id, amount: money(2495, 'EUR'), idempotencyKey: 'k' });
      expect(await payments.cancelAuthorization(id, 'c1')).toMatchObject({ ok: true, value: { status: 'canceled' } });
      expect(await kinds(id)).toEqual(['authorize:succeeded', 'cancel:succeeded']);

      // A flaky gateway that authorized but cannot cancel leaves money reserved: say so loudly.
      const flaky = await start({}, 'flaky');
      await sql`update payment_session set status = 'authorized' where id = ${flaky.id}`.execute(t.db);
      expect(await payments.cancelAuthorization(flaky.id, 'c2')).toMatchObject({
        ok: false,
        error: { code: 'payment_provider_failed' },
      });
      const events = await sql<{ topic: string }>`select topic from outbox_event where topic = 'payment.cancel_failed'`.execute(t.db);
      expect(events.rows).toHaveLength(1);
    });
  });

  describe('capture', () => {
    const eur = (amount: number) => money(amount, 'EUR');

    /** An authorized session; the flaky provider cannot authorize, so its session is marked authorized directly. */
    async function authorized(data: Record<string, unknown> = {}, providerId = 'test', captureMode: 'immediate' | 'manual' = 'immediate') {
      await payments.setProviderChannels(providerId, [{ channelId: 'chn_eu', captureMode }]);
      const started = await payments.startSession({ ...session, providerId, data });
      if (!started.ok) throw new Error(started.error.message);
      const { id } = started.value;
      if (providerId === 'flaky') {
        await sql`update payment_session set status = 'authorized' where id = ${id}`.execute(t.db);
      } else {
        await payments.authorizeSession({ sessionId: id, amount: eur(2495), idempotencyKey: `${id}:authorize` });
      }
      return id;
    }
    const captures = async (id: string) =>
      (await payments.listTransactions(id)).filter((tx) => tx.kind === 'capture').map((tx) => `${tx.status}:${tx.amount.amount}`);
    const topics = async (sessionId: string) =>
      (await sql<{ topic: string }>`select topic from outbox_event where payload->>'sessionId' = ${sessionId}`.execute(t.db)).rows.map(
        (r) => r.topic,
      );

    it('records the channel’s capture mode on the session', async () => {
      const id = await authorized({}, 'test', 'manual');
      expect(await payments.getSession(id)).toMatchObject({ captureMode: 'manual', capturedAmount: eur(0) });
    });

    it('captures everything by default, and a repeat with the same key is a no-op', async () => {
      const id = await authorized();
      expect(await payments.captureSession({ sessionId: id, idempotencyKey: 'cap-1' })).toMatchObject({
        ok: true,
        value: { status: 'captured', capturedAmount: eur(2495) },
      });
      expect(await payments.captureSession({ sessionId: id, idempotencyKey: 'cap-1' })).toMatchObject({ ok: true });
      expect(await captures(id)).toEqual(['succeeded:2495']);
      expect(await topics(id)).toContain('payment.captured');

      expect(await payments.captureSession({ sessionId: id, idempotencyKey: 'cap-2' })).toMatchObject({
        ok: false,
        error: { code: 'payment_not_capturable', details: { status: 'captured' } },
      });
      // A captured payment is not released by a compensation.
      expect(await payments.cancelAuthorization(id, 'c')).toMatchObject({ ok: true, value: { status: 'captured' } });
    });

    it('captures in parts, up to what was authorized', async () => {
      const id = await authorized({}, 'test', 'manual');
      expect(await payments.captureSession({ sessionId: id, amount: eur(1000), idempotencyKey: 'p1' })).toMatchObject({
        ok: true,
        value: { status: 'partially_captured', capturedAmount: eur(1000) },
      });
      for (const amount of [eur(1496), eur(0), money(100, 'USD')]) {
        expect(await payments.captureSession({ sessionId: id, amount, idempotencyKey: 'bad' })).toMatchObject({
          ok: false,
          error: { code: 'invalid_input' },
        });
      }
      expect(await payments.captureSession({ sessionId: id, idempotencyKey: 'p2' })).toMatchObject({
        ok: true,
        value: { status: 'captured', capturedAmount: eur(2495) },
      });
      expect(await captures(id)).toEqual(['succeeded:1000', 'succeeded:1495']);
    });

    it('refuses payments that are not authorized', async () => {
      const started = await payments.startSession({ ...session, data: {} });
      if (!started.ok) throw new Error(started.error.message);
      expect(await payments.captureSession({ sessionId: started.value.id, idempotencyKey: 'k' })).toMatchObject({
        ok: false,
        error: { code: 'payment_not_capturable', details: { status: 'pending' } },
      });
      expect(await payments.captureSession({ sessionId: 'pays_none', idempotencyKey: 'k' })).toMatchObject({
        ok: false,
        error: { code: 'payment_session_not_found' },
      });
    });

    it('runs one capture at a time, and takes over an abandoned one', async () => {
      const id = await authorized();
      await sql`update payment_session set capture_started_at = now() where id = ${id}`.execute(t.db);
      expect(await payments.captureSession({ sessionId: id, idempotencyKey: 'k' })).toMatchObject({
        ok: false,
        error: { code: 'payment_capture_in_progress' },
      });
      await sql`update payment_session set capture_started_at = now() - interval '6 minutes' where id = ${id}`.execute(t.db);
      expect(await payments.captureSession({ sessionId: id, idempotencyKey: 'k' })).toMatchObject({
        ok: true,
        value: { status: 'captured' },
      });
    });

    it('captures concurrent requests exactly once', async () => {
      const id = await authorized();
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) => payments.captureSession({ sessionId: id, idempotencyKey: `race-${i}` })),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await captures(id)).toEqual(['succeeded:2495']);
    });

    it('leaves the payment authorized when the capture is declined or the provider fails', async () => {
      const declined = await authorized({ outcome: 'capture_decline' });
      expect(await payments.captureSession({ sessionId: declined, idempotencyKey: 'k' })).toMatchObject({
        ok: false,
        error: { code: 'payment_declined' },
      });
      expect(await payments.getSession(declined)).toMatchObject({ status: 'authorized', capturedAmount: eur(0) });
      expect(await captures(declined)).toEqual(['failed:2495']);
      expect(await topics(declined)).toContain('payment.capture_failed');

      const failing = await authorized({}, 'flaky');
      expect(await payments.captureSession({ sessionId: failing, idempotencyKey: 'k' })).toMatchObject({
        ok: false,
        error: { code: 'payment_provider_failed', message: /connection reset/ },
      });
      // The claim was released: a retry reaches the provider again.
      expect(await payments.captureSession({ sessionId: failing, idempotencyKey: 'k' })).toMatchObject({
        ok: false,
        error: { code: 'payment_provider_failed' },
      });
      expect(await captures(failing)).toEqual(['error:2495', 'error:2495']);
    });

    it('lists immediate captures still due, without manual, declined or hopeless ones', async () => {
      await sql`delete from payment_transaction`.execute(t.db);
      await sql`delete from payment_session`.execute(t.db);
      const due = await authorized();
      await authorized({}, 'test', 'manual');
      const declined = await authorized({ outcome: 'capture_decline' });
      await payments.captureSession({ sessionId: declined, idempotencyKey: 'k' });
      const failing = await authorized({}, 'flaky');
      for (let i = 1; i < MAX_AUTOMATIC_CAPTURE_ATTEMPTS; i++) await payments.captureSession({ sessionId: failing, idempotencyKey: 'k' });
      const captured = await authorized();
      await payments.captureSession({ sessionId: captured, idempotencyKey: 'k' });

      const later = new Date(Date.now() + 60_000);
      const ids = async () => (await payments.sessionsAwaitingCapture(later)).map((s) => s.id).sort();
      expect(await ids()).toEqual([due, failing].sort());
      expect(await payments.sessionsAwaitingCapture(new Date(Date.now() - 60_000))).toEqual([]);

      // One error too many: the sweep gives up on it.
      await payments.captureSession({ sessionId: failing, idempotencyKey: 'k' });
      expect(await ids()).toEqual([due]);
    });

    it('warns once about authorizations about to lapse with money uncaptured', async () => {
      const soon = await authorized({}, 'test', 'manual');
      const partly = await authorized({}, 'test', 'manual');
      await payments.captureSession({ sessionId: partly, amount: eur(495), idempotencyKey: 'k' });
      const done = await authorized({}, 'test', 'manual');
      await payments.captureSession({ sessionId: done, idempotencyKey: 'k' });
      await authorized({}, 'test', 'manual'); // lapses in 7 days: not yet
      await sql`update payment_session set authorization_expires_at = now() + interval '1 day' where id in (${soon}, ${partly}, ${done})`.execute(
        t.db,
      );

      const within = new Date(Date.now() + 2 * 24 * 3600_000);
      expect(await payments.warnExpiringAuthorizations(within)).toBe(2);
      expect(await payments.warnExpiringAuthorizations(within)).toBe(0);
      const events = await sql<{ payload: { sessionId: string; uncapturedAmount: number } }>`
        select payload from outbox_event where topic = 'payment.authorization_expiring'`.execute(t.db);
      expect(events.rows.map((r) => [r.payload.sessionId, r.payload.uncapturedAmount]).sort()).toEqual(
        [
          [soon, 2495],
          [partly, 2000],
        ].sort(),
      );
    });
  });
});
