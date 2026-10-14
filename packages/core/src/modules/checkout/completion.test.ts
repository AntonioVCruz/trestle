import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { describe, expect, it } from 'vitest';
import { money } from '../../kernel/money.js';
import { err, ok, type DomainError, type Result } from '../../kernel/result.js';
import {
  createCheckoutService,
  type AuthorizeError,
  type BeginError,
  type CompletingCart,
  type CheckoutDependencies,
} from './completion.js';
import type { CheckoutState } from './machine.js';

const eur = (amount: number) => money(amount, 'EUR');
const address = {
  firstName: 'Ada',
  lastName: 'L',
  company: null,
  line1: '1 Main St',
  line2: null,
  city: 'Berlin',
  postalCode: '10115',
  region: null,
  country: 'DE',
  phone: null,
};

function cartIn(state: CheckoutState): CompletingCart {
  return {
    id: 'cart_1',
    channelId: 'chn_eu',
    currency: 'EUR',
    checkoutState: state,
    email: 'ada@example.com',
    shippingAddress: address,
    billingAddress: address,
    shippingMethod: { optionId: 'ship_1', name: 'Standard', amount: eur(495) },
    lines: [],
    subtotal: eur(2000),
    adjustments: [],
    adjustmentsTotal: eur(495),
    total: eur(2495),
    paymentMethod: { providerId: 'test', sessionId: 'pays_1', amount: eur(2495) },
  };
}

/** Fakes for the three modules, recording every call in order. */
function setup(options: {
  state?: CheckoutState;
  begin?: Result<CompletingCart, BeginError>;
  authorize?: Result<{ captureMode: 'immediate' | 'manual' }, AuthorizeError> | Error;
  place?: Result<{ id: string }, DomainError<'invalid_input'>> | Error;
  existingOrder?: { id: string; paymentSessionId: string };
  cancel?: Result<unknown, DomainError>;
  capture?: Result<unknown, DomainError> | Error;
  stale?: CompletingCart[];
  awaitingCapture?: { sessionId: string; cartId: string }[];
} = {}) {
  const calls: string[] = [];
  const events: unknown[] = [];
  const throwOr = <T>(value: T | Error): T => {
    if (value instanceof Error) throw value;
    return value;
  };
  const deps: CheckoutDependencies = {
    carts: {
      getCart: async () => cartIn(options.state ?? 'payment_selected'),
      beginCompletion: async (_id, key) => {
        calls.push(`begin:${key}`);
        return options.begin ?? ok(cartIn('completing'));
      },
      abortCompletion: async (_id, { keepPayment }) => void calls.push(`abort:keepPayment=${keepPayment}`),
      markPlaced: async (_id, orderId) => {
        calls.push(`placed:${orderId}`);
        return ok(undefined);
      },
      staleCompletions: async () => options.stale ?? [],
    },
    payments: {
      authorize: async ({ idempotencyKey }) => {
        calls.push(`authorize:${idempotencyKey}`);
        return throwOr(options.authorize ?? ok({ captureMode: 'immediate' as const }));
      },
      cancel: async () => {
        calls.push('cancel');
        return options.cancel ?? ok(undefined);
      },
      capture: async (sessionId, idempotencyKey) => {
        calls.push(`capture:${sessionId}:${idempotencyKey}`);
        return throwOr(options.capture ?? ok(undefined));
      },
      awaitingCapture: async () => options.awaitingCapture ?? [],
    },
    orders: {
      placeOrder: async () => {
        calls.push('place');
        return throwOr(options.place ?? ok({ id: 'ord_1' }));
      },
      getOrderByCart: async () => options.existingOrder,
    },
  };
  // Only compensation failures write to the database (an outbox event); capture what they write.
  const database = new Kysely<{}>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => void events.push(event.query.parameters),
  });
  return { service: createCheckoutService(database, deps), calls, events };
}

describe('completeCart', () => {
  it('runs begin, authorize, place, finish and capture in order', async () => {
    const { service, calls } = setup();
    expect(await service.completeCart('cart_1', 'key-1')).toEqual({ ok: true, value: { orderId: 'ord_1', replayed: false } });
    expect(calls).toEqual(['begin:key-1', 'authorize:pays_1:authorize', 'place', 'placed:ord_1', 'capture:pays_1:pays_1:capture']);
  });

  it('leaves the payment authorized when the channel captures manually', async () => {
    const { service, calls } = setup({ authorize: ok({ captureMode: 'manual' }) });
    expect(await service.completeCart('cart_1', 'key')).toMatchObject({ ok: true });
    expect(calls.at(-1)).toBe('placed:ord_1');
  });

  it('places the order even when capturing fails or throws', async () => {
    for (const capture of [err('payment_declined', 'no'), new Error('payments down')]) {
      const { service, calls } = setup({ capture });
      expect(await service.completeCart('cart_1', 'key')).toEqual({ ok: true, value: { orderId: 'ord_1', replayed: false } });
      expect(calls).not.toContain('cancel');
    }
  });

  it('requires a sane idempotency key', async () => {
    for (const key of ['', 'has space', 'x'.repeat(256), 'ünïcode']) {
      expect(await setup().service.completeCart('cart_1', key)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    }
  });

  it('returns the existing order for a placed cart, without running anything', async () => {
    const { service, calls } = setup({ state: 'placed', existingOrder: { id: 'ord_9', paymentSessionId: 'pays_1' } });
    expect(await service.completeCart('cart_1', 'any-key')).toEqual({ ok: true, value: { orderId: 'ord_9', replayed: true } });
    expect(calls).toEqual([]);
  });

  it('finishes a completion that crashed after placing the order', async () => {
    const { service, calls } = setup({ state: 'completing', existingOrder: { id: 'ord_9', paymentSessionId: 'pays_1' } });
    expect(await service.completeCart('cart_1', 'key')).toEqual({ ok: true, value: { orderId: 'ord_9', replayed: true } });
    expect(calls).toEqual(['placed:ord_9']);
  });

  it('refuses a concurrent attempt while another is running', async () => {
    const { service, calls } = setup({ state: 'completing' });
    expect(await service.completeCart('cart_1', 'key')).toMatchObject({ ok: false, error: { code: 'completion_in_progress' } });
    expect(calls).toEqual([]);
  });

  it('stops at begin without compensating when re-validation fails', async () => {
    const { service, calls } = setup({ begin: err('cart_changed', 'prices changed') });
    expect(await service.completeCart('cart_1', 'key')).toMatchObject({ ok: false, error: { code: 'cart_changed' } });
    expect(calls).toEqual(['begin:key']);
  });

  it('releases the cart without its payment when the payment is declined', async () => {
    const { service, calls } = setup({ authorize: err('payment_declined', 'declined') });
    expect(await service.completeCart('cart_1', 'key')).toMatchObject({ ok: false, error: { code: 'payment_declined' } });
    expect(calls).toEqual(['begin:key', 'authorize:pays_1:authorize', 'abort:keepPayment=false']);
  });

  it('keeps the payment when the shopper must act or the provider failed', async () => {
    for (const code of ['payment_requires_action', 'payment_provider_failed'] as const) {
      const { service, calls } = setup({ authorize: err(code, code) });
      expect(await service.completeCart('cart_1', 'key')).toMatchObject({ ok: false, error: { code } });
      expect(calls.at(-1)).toBe('abort:keepPayment=true');
    }
  });

  it('cancels the authorization and releases the cart when placing the order fails', async () => {
    const { service, calls } = setup({ place: err('invalid_input', 'missing details') });
    expect(await service.completeCart('cart_1', 'key')).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(calls).toEqual(['begin:key', 'authorize:pays_1:authorize', 'place', 'cancel', 'abort:keepPayment=false']);
  });

  it('compensates and rethrows when a step throws', async () => {
    const placing = setup({ place: new Error('database down') });
    await expect(placing.service.completeCart('cart_1', 'key')).rejects.toThrow('database down');
    expect(placing.calls.slice(-2)).toEqual(['cancel', 'abort:keepPayment=false']);

    const authorizing = setup({ authorize: new Error('payments down') });
    await expect(authorizing.service.completeCart('cart_1', 'key')).rejects.toThrow('payments down');
    expect(authorizing.calls.at(-1)).toBe('abort:keepPayment=true');
  });

  it('records a compensation that fails, and still runs the rest', async () => {
    const { service, calls, events } = setup({
      place: err('invalid_input', 'x'),
      cancel: err('payment_provider_failed', 'gateway down'),
    });
    await service.completeCart('cart_1', 'key');
    expect(calls.slice(-2)).toEqual(['cancel', 'abort:keepPayment=false']);
    expect(JSON.stringify(events)).toContain('checkout.compensation_failed');
    expect(JSON.stringify(events)).toContain('gateway down');
  });
});

describe('recoverStale', () => {
  it('finishes carts whose order exists, and undoes the others', async () => {
    const withOrder = setup({ stale: [cartIn('completing')], existingOrder: { id: 'ord_1', paymentSessionId: 'pays_1' } });
    expect(await withOrder.service.recoverStale(new Date())).toBe(1);
    expect(withOrder.calls).toEqual(['placed:ord_1']);

    const withoutOrder = setup({ stale: [cartIn('completing')] });
    expect(await withoutOrder.service.recoverStale(new Date())).toBe(1);
    expect(withoutOrder.calls).toEqual(['cancel', 'abort:keepPayment=false']);
  });
});

describe('captureDue', () => {
  it('captures payments whose order exists, and skips the others', async () => {
    const { service, calls } = setup({
      existingOrder: { id: 'ord_1', paymentSessionId: 'pays_1' },
      awaitingCapture: [
        { sessionId: 'pays_1', cartId: 'cart_1' },
        // Same cart, but the order was paid with another session: an earlier, abandoned attempt.
        { sessionId: 'pays_0', cartId: 'cart_1' },
      ],
    });
    expect(await service.captureDue(new Date())).toBe(1);
    expect(calls).toEqual(['capture:pays_1:pays_1:capture']);

    const noOrder = setup({ awaitingCapture: [{ sessionId: 'pays_1', cartId: 'cart_1' }] });
    expect(await noOrder.service.captureDue(new Date())).toBe(0);
    expect(noOrder.calls).toEqual([]);
  });
});
