import type { CoreDatabase } from '../../kernel/db.js';
import type { Money } from '../../kernel/money.js';
import { recordEvent } from '../../kernel/outbox.js';
import { err, ok, type DomainError, type Result } from '../../kernel/result.js';
import type { Adjustment } from '../../kernel/totals.js';
import type { CheckoutState } from './machine.js';

/**
 * Completing a cart into an order: the saga of ADR 0005 (ADR 0018). Each step that can be undone
 * has a compensation, run in reverse if a later step fails:
 *
 *   1. begin      re-validate prices and shipping, freeze the cart   ⟲ release the cart
 *   2. authorize  reserve the payment with the provider              ⟲ cancel the authorization
 *   3. place      record the order (idempotent per cart)
 *   4. finish     mark the cart placed
 *   5. capture    take the payment, if the channel captures immediately (ADR 0019)
 *
 * Once the order exists there is nothing to undo: finishing is retried, by a repeated request or
 * by `recoverStale`, and a capture that did not happen is retried by `captureDue`. Inventory
 * reservation becomes a step between 1 and 2 when that module exists.
 */

export interface CheckoutAddress {
  readonly firstName: string;
  readonly lastName: string;
  readonly company: string | null;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly postalCode: string;
  readonly region: string | null;
  readonly country: string;
  readonly phone: string | null;
}

export interface CompletingLine {
  readonly id: string;
  readonly variantId: string;
  readonly productId: string;
  readonly productHandle: string;
  readonly productTitle: string;
  readonly variantTitle: string;
  readonly sku: string | null;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly originalUnitPrice: Money | null;
  readonly subtotal: Money;
  readonly total: Money;
}

/** The cart as completion sees it. */
export interface CompletingCart {
  readonly id: string;
  readonly channelId: string;
  readonly currency: string;
  readonly checkoutState: CheckoutState;
  readonly email: string | null;
  readonly shippingAddress: CheckoutAddress | null;
  readonly billingAddress: CheckoutAddress | null;
  readonly shippingMethod: { readonly optionId: string; readonly name: string; readonly amount: Money } | null;
  readonly lines: readonly CompletingLine[];
  readonly subtotal: Money;
  readonly adjustments: readonly Adjustment[];
  readonly adjustmentsTotal: Money;
  readonly total: Money;
  readonly paymentMethod: { readonly providerId: string; readonly sessionId: string; readonly amount: Money } | null;
}

export type BeginError = DomainError<
  | 'cart_not_found'
  | 'completion_in_progress'
  | 'cart_placed'
  | 'payment_required'
  | 'cart_changed'
  | 'cart_not_ready'
  | 'variant_not_available'
  | 'variant_not_priced'
  | 'shipping_option_unavailable'
>;

export type AuthorizeError = DomainError<
  | 'payment_session_not_found'
  | 'payment_session_unusable'
  | 'payment_amount_mismatch'
  | 'payment_declined'
  | 'payment_requires_action'
  | 'payment_provider_failed'
>;

/** What completion needs from the cart module. */
export interface CompletionCarts {
  getCart(cartId: string): Promise<CompletingCart | undefined>;
  beginCompletion(cartId: string, completionKey: string): Promise<Result<CompletingCart, BeginError>>;
  abortCompletion(cartId: string, options: { keepPayment: boolean }): Promise<unknown>;
  markPlaced(cartId: string, orderId: string): Promise<Result<unknown, DomainError>>;
  staleCompletions(startedBefore: Date): Promise<CompletingCart[]>;
}

/** What completion needs from the payments module. */
export interface CompletionPayments {
  authorize(input: {
    sessionId: string;
    amount: Money;
    idempotencyKey: string;
  }): Promise<Result<{ readonly captureMode: 'immediate' | 'manual' }, AuthorizeError>>;
  cancel(sessionId: string, idempotencyKey: string): Promise<Result<unknown, DomainError>>;
  /** Captures everything authorized. Failures are recorded by the payments module. */
  capture(sessionId: string, idempotencyKey: string): Promise<Result<unknown, DomainError>>;
  /** Authorized payments of channels that capture immediately, still not captured. */
  awaitingCapture(lastChangedBefore: Date): Promise<readonly { readonly sessionId: string; readonly cartId: string }[]>;
}

/** What completion needs from the orders module. */
export interface CompletionOrders {
  /** Idempotent per cart. */
  placeOrder(cart: CompletingCart): Promise<Result<{ readonly id: string }, DomainError<'invalid_input'>>>;
  getOrderByCart(cartId: string): Promise<{ readonly id: string; readonly paymentSessionId: string } | undefined>;
}

export interface CheckoutDependencies {
  readonly carts: CompletionCarts;
  readonly payments: CompletionPayments;
  readonly orders: CompletionOrders;
}

export interface CompletionResult {
  readonly orderId: string;
  /** True when the cart had already been placed and this call only reported it. */
  readonly replayed: boolean;
}

export type CompleteCartError = BeginError | AuthorizeError | DomainError<'invalid_input'>;

export interface CheckoutService {
  /** Places the cart's order. Safe to repeat: a placed cart returns its order. */
  completeCart(cartId: string, idempotencyKey: string): Promise<Result<CompletionResult, CompleteCartError>>;
  /**
   * Finishes or undoes completions abandoned mid-way (a crash between steps): carts whose order
   * exists are marked placed; others have their authorization canceled and are released.
   * Returns how many carts were recovered.
   */
  recoverStale(startedBefore: Date): Promise<number>;
  /**
   * Captures immediate-capture payments that were authorized for a placed order but not
   * captured: the process died, or the provider failed. Returns how many it attempted.
   */
  captureDue(lastChangedBefore: Date): Promise<number>;
}

/** A compensation could not run; someone must look (e.g. money still authorized). */
export const COMPENSATION_FAILED = 'checkout.compensation_failed';

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

/** After these, the payment session can still be used for another attempt. */
const PAYMENT_STILL_USABLE: readonly AuthorizeError['code'][] = ['payment_requires_action', 'payment_provider_failed'];

export function createCheckoutService(database: CoreDatabase, deps: CheckoutDependencies): CheckoutService {
  const { carts, payments, orders } = deps;

  /** Runs compensations in order; one failing does not stop the others, and is recorded. */
  async function compensate(cartId: string, steps: readonly [string, () => Promise<unknown>][]) {
    for (const [step, run] of steps) {
      try {
        const result = await run();
        if (isFailedResult(result)) throw new Error(result.error.message);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await recordEvent(database, COMPENSATION_FAILED, { cartId, step, reason }).catch(() => {});
      }
    }
  }

  /** The order exists: finishing the cart can only fail transiently and is retried later. */
  async function finish(cartId: string, orderId: string) {
    try {
      await carts.markPlaced(cartId, orderId);
    } catch {
      // The cart stays `completing`; a repeated request or `recoverStale` finishes it.
    }
  }

  const cancelPayment = (sessionId: string) => () => payments.cancel(sessionId, `${sessionId}:cancel`);

  /** The order stands whatever happens here: a failed capture is recorded and retried later. */
  async function capture(sessionId: string) {
    try {
      await payments.capture(sessionId, `${sessionId}:capture`);
    } catch {
      // Left authorized; `captureDue` tries again.
    }
  }

  return {
    async completeCart(cartId, idempotencyKey) {
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
        return err('invalid_input', 'The idempotency key must be 1 to 255 printable ASCII characters');
      }

      const current = await carts.getCart(cartId);
      if (!current) return err('cart_not_found', `Cart "${cartId}" not found`);
      if (current.checkoutState === 'placed' || current.checkoutState === 'completing') {
        const existing = await orders.getOrderByCart(cartId);
        if (existing) {
          if (current.checkoutState === 'completing') await finish(cartId, existing.id);
          return ok({ orderId: existing.id, replayed: true });
        }
        return err('completion_in_progress', 'This cart is already being completed');
      }

      // 1. Begin: re-validate and freeze.
      const begun = await carts.beginCompletion(cartId, idempotencyKey);
      if (!begun.ok) return begun;
      const cart = begun.value;
      const session = cart.paymentMethod!;

      // 2. Authorize. The key is per session, so no retry can authorize the same payment twice.
      let authorized;
      try {
        authorized = await payments.authorize({ sessionId: session.sessionId, amount: cart.total, idempotencyKey: `${session.sessionId}:authorize` });
      } catch (error) {
        await compensate(cartId, [['release cart', () => carts.abortCompletion(cartId, { keepPayment: true })]]);
        throw error;
      }
      if (!authorized.ok) {
        const keepPayment = PAYMENT_STILL_USABLE.includes(authorized.error.code);
        await compensate(cartId, [['release cart', () => carts.abortCompletion(cartId, { keepPayment })]]);
        return authorized;
      }

      // 3. Place the order.
      const undoAuthorization: [string, () => Promise<unknown>][] = [
        ['cancel authorization', cancelPayment(session.sessionId)],
        ['release cart', () => carts.abortCompletion(cartId, { keepPayment: false })],
      ];
      let order;
      try {
        order = await orders.placeOrder(cart);
      } catch (error) {
        await compensate(cartId, undoAuthorization);
        throw error;
      }
      if (!order.ok) {
        await compensate(cartId, undoAuthorization);
        return order;
      }

      // 4. Finish.
      await finish(cartId, order.value.id);

      // 5. Capture, if the channel captures immediately.
      if (authorized.value.captureMode === 'immediate') await capture(session.sessionId);
      return ok({ orderId: order.value.id, replayed: false });
    },

    async recoverStale(startedBefore) {
      const stale = await carts.staleCompletions(startedBefore);
      for (const cart of stale) {
        const existing = await orders.getOrderByCart(cart.id);
        if (existing) {
          await finish(cart.id, existing.id);
          continue;
        }
        const steps: [string, () => Promise<unknown>][] = [];
        if (cart.paymentMethod) steps.push(['cancel authorization', cancelPayment(cart.paymentMethod.sessionId)]);
        steps.push(['release cart', () => carts.abortCompletion(cart.id, { keepPayment: false })]);
        await compensate(cart.id, steps);
      }
      return stale.length;
    },

    async captureDue(lastChangedBefore) {
      let attempted = 0;
      for (const { sessionId, cartId } of await payments.awaitingCapture(lastChangedBefore)) {
        // Only once the order exists: otherwise the saga is still running, or was undone.
        const order = await orders.getOrderByCart(cartId);
        if (order?.paymentSessionId !== sessionId) continue;
        await capture(sessionId);
        attempted++;
      }
      return attempted;
    },
  };
}

function isFailedResult(value: unknown): value is { ok: false; error: DomainError } {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false && 'error' in value;
}
