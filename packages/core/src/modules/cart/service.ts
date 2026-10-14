import { sql, type Kysely, type Selectable } from 'kysely';
import type { CoreDatabase } from '../../kernel/db.js';
import { newId } from '../../kernel/id.js';
import { isCurrencyCode, money, type CurrencyCode, type Money } from '../../kernel/money.js';
import { recordEvent, type OutboxTables } from '../../kernel/outbox.js';
import { err, ok, type DomainError, type Result } from '../../kernel/result.js';
import type { Adjuster, Adjustment } from '../../kernel/totals.js';
import type { CheckoutState } from '../checkout/index.js';
import {
  applyShippingQuote,
  choosePayment,
  chooseShipping,
  EMPTY_CHECKOUT,
  enterAddresses,
  isLocked,
  optionToQuote,
  reconcilePayment,
  shippingAdjuster,
  type Address,
  type AddressesInput,
  type CartLocked,
  type CheckoutData,
  type SelectedPayment,
  type ShippingQuote,
} from './checkout.js';
import {
  addLine,
  cartTotals,
  priceLines,
  removeLine,
  setLineQuantity,
  type CartLineState,
  type DesiredLine,
  type LineOperationError,
  type LinePrice,
  type PricingError,
  type SellableVariant,
} from './rules.js';
import type { CartLineTable, CartTable, CartTables, StoredAdjustment } from './tables.js';

/**
 * Carts: lines of variants in one channel and currency, plus the checkout steps collected on
 * them (ADR 0015, ADR 0016). Every change re-prices all lines and the chosen shipping method,
 * runs the adjuster pipeline (ADR 0006) and stores the totals, so reads never recompute.
 */
export interface Cart {
  readonly id: string;
  readonly channelId: string;
  readonly currency: CurrencyCode;
  readonly lines: readonly CartLine[];
  readonly subtotal: Money;
  readonly adjustments: readonly Adjustment[];
  readonly adjustmentsTotal: Money;
  readonly total: Money;
  readonly checkoutState: CheckoutState;
  readonly email: string | null;
  readonly shippingAddress: Address | null;
  readonly billingAddress: Address | null;
  readonly shippingMethod: ShippingQuote | null;
  readonly paymentMethod: SelectedPayment | null;
  /** The order this cart became, once placed. */
  readonly orderId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CartLine extends CartLineState {
  readonly subtotal: Money;
  readonly total: Money;
}

/** What the cart needs from the catalog. The composition root adapts the catalog service. */
export interface CartCatalog {
  /** Variants for sale in the channel now; unknown, unpublished or unlisted ones are absent. */
  sellableVariants(variantIds: readonly string[], channelId: string): Promise<ReadonlyMap<string, SellableVariant>>;
}

/** What the cart needs from pricing. The composition root adapts the pricing service. */
export interface CartPricing {
  /** The unit price per variant for its line quantity; variants without a price are absent. */
  unitPrices(
    lines: readonly { readonly variantId: string; readonly quantity: number }[],
    context: { readonly currency: CurrencyCode; readonly channelId: string; readonly at: Date },
  ): Promise<ReadonlyMap<string, LinePrice>>;
}

export interface ShippingContext {
  readonly channelId: string;
  readonly currency: CurrencyCode;
  readonly country: string;
}

/** What the cart needs from shipping. The composition root adapts the shipping service. */
export interface CartShipping {
  /** Options that can ship this cart, cheapest first. */
  quotes(context: ShippingContext): Promise<ShippingQuote[]>;
}

export interface PaymentSessionRequest {
  readonly cartId: string;
  readonly channelId: string;
  readonly providerId: string;
  readonly amount: Money;
  readonly email: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

export type PaymentSessionError = DomainError<'invalid_input' | 'payment_method_unavailable' | 'payment_initiation_failed'>;

/** What the cart needs from payments. The composition root adapts the payments service. */
export interface CartPayments {
  /** Payment methods the channel offers. */
  methods(channelId: string): Promise<{ readonly providerId: string; readonly name: string }[]>;
  /** Prepares a payment with the provider for the given amount. */
  startSession(request: PaymentSessionRequest): Promise<Result<SelectedPayment, PaymentSessionError>>;
}

export interface CartDependencies {
  readonly catalog: CartCatalog;
  readonly pricing: CartPricing;
  readonly shipping: CartShipping;
  readonly payments: CartPayments;
  /** Promotions, tax and fees, as they arrive (ADR 0006). Shipping is built in. */
  readonly adjusters: readonly Adjuster[];
}

export interface CreateCartInput {
  readonly channelId: string;
  /** Callers check it is one of the channel's currencies. */
  readonly currency: CurrencyCode;
}

type CartNotFound = DomainError<'cart_not_found'>;

/**
 * What re-pricing a cart can fail with. Every command re-prices, so each command's error type
 * includes these, even where the command cannot trigger one (e.g. a line change never chooses a
 * shipping option).
 */
export type RepriceError = CartNotFound | PricingError | DomainError<'shipping_option_unavailable'>;

export type CreateCartError = DomainError<'invalid_input'>;
export type AddLineError = RepriceError | CartLocked | LineOperationError;
export type UpdateLineError = AddLineError;
export type RemoveLineError = AddLineError;
export type SetAddressesError = RepriceError | CartLocked | DomainError<'invalid_input' | 'cart_empty'>;
export type ListShippingOptionsError = CartNotFound | DomainError<'address_required'>;
export type SelectShippingOptionError = RepriceError | CartLocked | DomainError<'address_required'>;
export type ListPaymentMethodsError = CartNotFound;
export type SelectPaymentMethodError =
  | CartNotFound
  | CartLocked
  | PaymentSessionError
  | DomainError<'shipping_required' | 'cart_changed'>;
export type BeginCompletionError =
  | RepriceError
  | DomainError<'completion_in_progress' | 'cart_placed' | 'payment_required' | 'cart_changed' | 'cart_not_ready'>;
export type MarkPlacedError = CartNotFound | DomainError<'cart_not_completing'>;

export interface CartService {
  createCart(input: CreateCartInput): Promise<Result<Cart, CreateCartError>>;
  getCart(id: string): Promise<Cart | undefined>;
  addLine(cartId: string, input: { variantId: string; quantity: number }): Promise<Result<Cart, AddLineError>>;
  updateLineQuantity(cartId: string, lineId: string, quantity: number): Promise<Result<Cart, UpdateLineError>>;
  removeLine(cartId: string, lineId: string): Promise<Result<Cart, RemoveLineError>>;
  /** Checkout step 1: contact email and addresses. */
  setAddresses(cartId: string, input: AddressesInput): Promise<Result<Cart, SetAddressesError>>;
  /** The shipping options that can ship this cart to its shipping address. */
  listShippingOptions(cartId: string): Promise<Result<ShippingQuote[], ListShippingOptionsError>>;
  /** Checkout step 2: one of `listShippingOptions`. */
  selectShippingOption(cartId: string, optionId: string): Promise<Result<Cart, SelectShippingOptionError>>;
  /** Payment methods offered in the cart's channel. */
  listPaymentMethods(cartId: string): Promise<Result<{ providerId: string; name: string }[], ListPaymentMethodsError>>;
  /**
   * Checkout step 3: prepares a payment for the cart total with the chosen provider. The provider
   * is called without holding the cart lock; if the cart changed meanwhile, the step is refused
   * with `cart_changed` and can simply be repeated.
   */
  selectPaymentMethod(
    cartId: string,
    input: { providerId: string; data?: Readonly<Record<string, unknown>> },
  ): Promise<Result<Cart, SelectPaymentMethodError>>;
  /**
   * Completion, step 1 (ADR 0018): re-validates every price and the shipping option, then freezes
   * the cart in `completing` under `completionKey`. If anything changed the total, the re-priced
   * cart is saved without its payment and `cart_changed` is returned.
   */
  beginCompletion(cartId: string, completionKey: string): Promise<Result<Cart, BeginCompletionError>>;
  /**
   * Compensation: releases a `completing` cart. It keeps its payment choice only if the payment
   * can still be used; otherwise it goes back to the shipping step.
   */
  abortCompletion(cartId: string, options: { keepPayment: boolean }): Promise<Result<Cart, CartNotFound>>;
  /** Completion, last step: the cart became `orderId`. */
  markPlaced(cartId: string, orderId: string): Promise<Result<Cart, MarkPlacedError>>;
  /** Carts left `completing` since before `startedBefore`, e.g. by a crash mid-completion. */
  staleCompletions(startedBefore: Date, limit?: number): Promise<Cart[]>;
}

export const CART_CREATED = 'cart.created';
export const CART_UPDATED = 'cart.updated';

type Db = Kysely<CartTables & OutboxTables>;

/** The cart as an operation sees it. */
interface CartState {
  readonly lines: readonly CartLineState[];
  readonly checkout: CheckoutData;
}

/** What an operation wants the cart to become. */
interface CartDraft {
  readonly lines: readonly DesiredLine[];
  readonly checkout: CheckoutData;
  /** A shipping option chosen by this operation; it must be quotable. */
  readonly chosenShippingOptionId?: string;
}

/** What a `finalize` hook returns: the checkout to store, and a completion key when completing. */
interface Finalized {
  readonly checkout: CheckoutData;
  readonly completionKey?: string;
}

const keepLines = (lines: readonly CartLineState[]): DesiredLine[] =>
  lines.map((l) => ({ id: l.id, variantId: l.variantId, quantity: l.quantity, previous: l }));

export function createCartService(database: CoreDatabase, deps: CartDependencies): CartService {
  const db: Db = database.withTables<CartTables & OutboxTables>();

  const loadCart = async (conn: Db, id: string) => {
    const row = await conn.selectFrom('cart').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) return undefined;
    const lines = await conn.selectFrom('cart_line').selectAll().where('cart_id', '=', id).orderBy('id').execute();
    return toCart(row, lines);
  };

  /** Line operations wait for nothing but the lock: completion freezes the cart. */
  const lineOperation =
    (operation: (lines: readonly CartLineState[]) => Result<DesiredLine[], LineOperationError>) =>
    ({ lines, checkout }: CartState): Result<CartDraft, LineOperationError | CartLocked> => {
      if (isLocked(checkout.state)) return err('cart_locked', 'The cart is being completed and cannot change');
      const wanted = operation(lines);
      return wanted.ok ? ok({ lines: wanted.value, checkout }) : wanted;
    };

  /**
   * Runs an operation under a lock on the cart, then re-prices every line and the shipping
   * method, runs the adjusters, and stores lines, checkout data and totals together.
   *
   * `finalize` sees the re-priced result before it is stored and may move the checkout further
   * (completion does). If it refuses, the re-priced cart is still stored, so the shopper sees
   * what changed, and its error is returned.
   */
  async function change<E extends DomainError, F extends DomainError = never>(
    cartId: string,
    operation: (state: CartState) => Result<CartDraft, E>,
    finalize?: (
      checkout: CheckoutData,
      lines: readonly CartLineState[],
    ) => Result<Finalized, F>,
  ): Promise<Result<Cart, E | F | RepriceError>> {
    return db.transaction().execute(async (trx) => {
      const cart = await trx.selectFrom('cart').selectAll().where('id', '=', cartId).forUpdate().executeTakeFirst();
      if (!cart) return err('cart_not_found', `Cart "${cartId}" not found`);
      const lines = (await trx.selectFrom('cart_line').selectAll().where('cart_id', '=', cartId).orderBy('id').execute()).map(
        (row) => toLineState(row, cart.currency),
      );

      const draft = operation({ lines, checkout: toCheckout(cart) });
      if (!draft.ok) return draft;
      const { checkout: wanted, chosenShippingOptionId } = draft.value;

      const context = { channelId: cart.channel_id, currency: cart.currency };
      const optionId = optionToQuote(wanted, chosenShippingOptionId);
      const [sellable, prices, quotes] = await Promise.all([
        deps.catalog.sellableVariants(
          draft.value.lines.map((l) => l.variantId),
          cart.channel_id,
        ),
        deps.pricing.unitPrices(draft.value.lines, { ...context, at: new Date() }),
        optionId && wanted.shippingAddress
          ? deps.shipping.quotes({ ...context, country: wanted.shippingAddress.country })
          : Promise.resolve([]),
      ]);
      const priced = priceLines(draft.value.lines, sellable, prices);
      if (!priced.ok) return priced;
      const checkout = applyShippingQuote(
        wanted,
        chosenShippingOptionId,
        quotes.find((q) => q.optionId === optionId),
      );
      if (!checkout.ok) return checkout;

      const adjusters = checkout.value.shipping ? [...deps.adjusters, shippingAdjuster(checkout.value.shipping)] : deps.adjusters;
      const totals = cartTotals(cart.currency, priced.value, adjusters);
      const reconciled = reconcilePayment(checkout.value, totals.total);
      const finalized: Result<Finalized, F> = finalize ? finalize(reconciled, priced.value) : ok({ checkout: reconciled });
      const stored = finalized.ok ? finalized.value.checkout : reconciled;
      const lineTotals = new Map(totals.lines.map((l) => [l.lineId, l]));

      const keep = priced.value.map((l) => l.id);
      await trx
        .deleteFrom('cart_line')
        .where('cart_id', '=', cartId)
        .$if(keep.length > 0, (q) => q.where('id', 'not in', keep))
        .execute();
      if (priced.value.length > 0) {
        await trx
          .insertInto('cart_line')
          .values(
            priced.value.map((line) => {
              const t = lineTotals.get(line.id);
              return {
                id: line.id,
                cart_id: cartId,
                variant_id: line.variantId,
                product_id: line.productId,
                product_handle: line.productHandle,
                product_title: line.productTitle,
                variant_title: line.variantTitle,
                sku: line.sku,
                quantity: line.quantity,
                unit_price: line.unitPrice.amount,
                original_unit_price: line.originalUnitPrice?.amount ?? null,
                // Unavailable lines are outside the totals; they keep their own arithmetic.
                subtotal: t?.subtotal.amount ?? line.unitPrice.amount * line.quantity,
                total: t?.total.amount ?? line.unitPrice.amount * line.quantity,
                available: line.available,
              };
            }),
          )
          .onConflict((oc) =>
            oc.column('id').doUpdateSet((eb) => ({
              product_id: eb.ref('excluded.product_id'),
              product_handle: eb.ref('excluded.product_handle'),
              product_title: eb.ref('excluded.product_title'),
              variant_title: eb.ref('excluded.variant_title'),
              sku: eb.ref('excluded.sku'),
              quantity: eb.ref('excluded.quantity'),
              unit_price: eb.ref('excluded.unit_price'),
              original_unit_price: eb.ref('excluded.original_unit_price'),
              subtotal: eb.ref('excluded.subtotal'),
              total: eb.ref('excluded.total'),
              available: eb.ref('excluded.available'),
            })),
          )
          .execute();
      }

      const { state, email, shippingAddress, billingAddress, shipping, payment } = stored;
      const adjustments: StoredAdjustment[] = totals.adjustments.map((a) => ({ ...a, amount: a.amount.amount }));
      await trx
        .updateTable('cart')
        .set({
          subtotal: totals.subtotal.amount,
          adjustments: JSON.stringify(adjustments),
          adjustments_total: totals.adjustmentsTotal.amount,
          total: totals.total.amount,
          checkout_state: state,
          email,
          shipping_address: shippingAddress && JSON.stringify(shippingAddress),
          billing_address: billingAddress && JSON.stringify(billingAddress),
          shipping_option_id: shipping?.optionId ?? null,
          shipping_option_name: shipping?.name ?? null,
          shipping_amount: shipping?.amount.amount ?? null,
          ...paymentColumns(payment),
          completion_key: finalized.ok && state === 'completing' ? (finalized.value.completionKey ?? null) : null,
          completion_started_at: finalized.ok && state === 'completing' ? sql<Date>`now()` : null,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', cartId)
        .execute();
      await recordEvent(trx, CART_UPDATED, { id: cartId, checkoutState: state });
      return finalized.ok ? ok((await loadCart(trx, cartId))!) : finalized;
    });
  }

  /** Runs a small checkout transition under the cart lock, without re-pricing. */
  async function transition<E extends DomainError>(
    cartId: string,
    apply: (cart: Selectable<CartTable>) => Result<Partial<Record<keyof CartTable, unknown>> | null, E>,
  ): Promise<Result<Cart, E | CartNotFound>> {
    return db.transaction().execute(async (trx) => {
      const cart = await trx.selectFrom('cart').selectAll().where('id', '=', cartId).forUpdate().executeTakeFirst();
      if (!cart) return err('cart_not_found', `Cart "${cartId}" not found`);
      const changes = apply(cart);
      if (!changes.ok) return changes;
      if (changes.value) {
        await trx
          .updateTable('cart')
          .set({ ...(changes.value as object), updated_at: sql<Date>`now()` })
          .where('id', '=', cartId)
          .execute();
        await recordEvent(trx, CART_UPDATED, { id: cartId, checkoutState: changes.value.checkout_state ?? cart.checkout_state });
      }
      return ok((await loadCart(trx, cartId))!);
    });
  }

  return {
    async createCart({ channelId, currency }) {
      if (!isCurrencyCode(currency)) return err('invalid_input', `Invalid currency code "${currency}"`);
      const cart = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('cart')
          .values({
            id: newId('cart'),
            channel_id: channelId,
            currency,
            subtotal: 0,
            adjustments: '[]',
            adjustments_total: 0,
            total: 0,
            email: null,
            shipping_address: null,
            billing_address: null,
            shipping_option_id: null,
            shipping_option_name: null,
            shipping_amount: null,
            ...paymentColumns(null),
            completion_key: null,
            completion_started_at: null,
            order_id: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await recordEvent(trx, CART_CREATED, { id: row.id, channelId });
        return toCart(row, []);
      });
      return ok(cart);
    },

    getCart: (id) => loadCart(db, id),

    addLine: (cartId, { variantId, quantity }) =>
      change(
        cartId,
        lineOperation((lines) => addLine(lines, variantId, quantity, () => newId('line'))),
      ),

    updateLineQuantity: (cartId, lineId, quantity) =>
      change(
        cartId,
        lineOperation((lines) => setLineQuantity(lines, lineId, quantity)),
      ),

    removeLine: (cartId, lineId) =>
      change(
        cartId,
        lineOperation((lines) => removeLine(lines, lineId)),
      ),

    setAddresses: (cartId, input) =>
      change(cartId, ({ lines, checkout }) => {
        const next = enterAddresses(
          checkout,
          input,
          lines.some((l) => l.available),
        );
        return next.ok ? ok({ lines: keepLines(lines), checkout: next.value }) : next;
      }),

    async listShippingOptions(cartId) {
      const cart = await db.selectFrom('cart').selectAll().where('id', '=', cartId).executeTakeFirst();
      if (!cart) return err('cart_not_found', `Cart "${cartId}" not found`);
      if (!cart.shipping_address) return err('address_required', 'Enter a shipping address first');
      return ok(
        await deps.shipping.quotes({
          channelId: cart.channel_id,
          currency: cart.currency,
          country: cart.shipping_address.country,
        }),
      );
    },

    selectShippingOption: (cartId, optionId) =>
      change(cartId, ({ lines, checkout }) => {
        const next = chooseShipping(checkout);
        return next.ok ? ok({ lines: keepLines(lines), checkout: next.value, chosenShippingOptionId: optionId }) : next;
      }),

    async listPaymentMethods(cartId) {
      const cart = await db.selectFrom('cart').select('channel_id').where('id', '=', cartId).executeTakeFirst();
      if (!cart) return err('cart_not_found', `Cart "${cartId}" not found`);
      return ok(await deps.payments.methods(cart.channel_id));
    },

    async selectPaymentMethod(cartId, { providerId, data = {} }) {
      const before = await db.selectFrom('cart').selectAll().where('id', '=', cartId).executeTakeFirst();
      if (!before) return err('cart_not_found', `Cart "${cartId}" not found`);
      const next = choosePayment(toCheckout(before));
      if (!next.ok) return next;

      const session = await deps.payments.startSession({
        cartId,
        channelId: before.channel_id,
        providerId,
        amount: money(Number(before.total), before.currency),
        email: before.email,
        data,
      });
      if (!session.ok) return session;

      return db.transaction().execute(async (trx): Promise<Result<Cart, SelectPaymentMethodError>> => {
        const now = await trx.selectFrom('cart').selectAll().where('id', '=', cartId).forUpdate().executeTakeFirstOrThrow();
        // Optimistic check: any change since the provider was asked would make the session stale.
        if (now.updated_at.getTime() !== before.updated_at.getTime()) {
          return err('cart_changed', 'The cart changed while the payment was being prepared; choose the payment method again');
        }
        await trx
          .updateTable('cart')
          .set({ checkout_state: next.value.state, ...paymentColumns(session.value), updated_at: sql<Date>`now()` })
          .where('id', '=', cartId)
          .execute();
        await recordEvent(trx, CART_UPDATED, { id: cartId, checkoutState: next.value.state });
        return ok((await loadCart(trx, cartId))!);
      });
    },

    beginCompletion: (cartId, completionKey) =>
      change(
        cartId,
        ({ lines, checkout }): Result<CartDraft, BeginCompletionError> => {
          if (checkout.state === 'completing') return err('completion_in_progress', 'This cart is already being completed');
          if (checkout.state === 'placed') return err('cart_placed', 'This cart has already been placed');
          if (checkout.state !== 'payment_selected' || !checkout.payment) {
            return err('payment_required', 'Choose a payment method before completing the cart');
          }
          return ok({ lines: keepLines(lines), checkout });
        },
        (checkout, lines): Result<Finalized, DomainError<'cart_changed' | 'cart_not_ready'>> => {
          if (checkout.state !== 'payment_selected' || !checkout.payment) {
            return err('cart_changed', 'Prices or shipping changed; review the cart and choose a payment method again');
          }
          if (lines.length === 0 || lines.some((l) => !l.available)) {
            return err('cart_not_ready', 'Remove unavailable items before completing the cart');
          }
          return ok({ checkout: { ...checkout, state: 'completing' }, completionKey });
        },
      ),

    abortCompletion: (cartId, { keepPayment }) =>
      transition(cartId, (cart) => {
        if (cart.checkout_state !== 'completing') return ok(null);
        const back = keepPayment && cart.payment_session_id ? 'payment_selected' : cart.shipping_option_id ? 'shipping_selected' : 'addressed';
        return ok({
          checkout_state: back,
          completion_key: null,
          completion_started_at: null,
          ...(back !== 'payment_selected' && paymentColumns(null)),
        });
      }),

    async staleCompletions(startedBefore, limit = 100) {
      const rows = await db
        .selectFrom('cart')
        .select('id')
        .where('checkout_state', '=', 'completing')
        .where('completion_started_at', '<', startedBefore)
        .orderBy('completion_started_at')
        .limit(limit)
        .execute();
      const carts = await Promise.all(rows.map((r) => loadCart(db, r.id)));
      return carts.filter((c): c is Cart => c !== undefined);
    },

    markPlaced: (cartId, orderId) =>
      transition(cartId, (cart): Result<Partial<Record<keyof CartTable, unknown>> | null, MarkPlacedError> => {
        if (cart.checkout_state === 'placed') return ok(null);
        if (cart.checkout_state !== 'completing') return err('cart_not_completing', 'The cart is not being completed');
        return ok({ checkout_state: 'placed', completion_key: null, completion_started_at: null, order_id: orderId });
      }),
  };
}

function paymentColumns(payment: SelectedPayment | null) {
  return {
    payment_provider_id: payment?.providerId ?? null,
    payment_provider_name: payment?.name ?? null,
    payment_session_id: payment?.sessionId ?? null,
    payment_amount: payment?.amount.amount ?? null,
    payment_client_data: payment ? JSON.stringify(payment.clientData) : null,
  };
}

function toCheckout(row: Selectable<CartTable>): CheckoutData {
  return {
    ...EMPTY_CHECKOUT,
    state: row.checkout_state,
    email: row.email,
    shippingAddress: row.shipping_address,
    billingAddress: row.billing_address,
    shipping:
      row.shipping_option_id === null
        ? null
        : {
            optionId: row.shipping_option_id,
            name: row.shipping_option_name!,
            amount: money(Number(row.shipping_amount), row.currency),
          },
    payment:
      row.payment_session_id === null
        ? null
        : {
            providerId: row.payment_provider_id!,
            name: row.payment_provider_name!,
            sessionId: row.payment_session_id,
            amount: money(Number(row.payment_amount), row.currency),
            clientData: row.payment_client_data ?? {},
          },
  };
}

function toLineState(row: Selectable<CartLineTable>, currency: CurrencyCode): CartLineState {
  return {
    id: row.id,
    variantId: row.variant_id,
    productId: row.product_id,
    productHandle: row.product_handle,
    productTitle: row.product_title,
    variantTitle: row.variant_title,
    sku: row.sku,
    quantity: row.quantity,
    unitPrice: money(Number(row.unit_price), currency),
    originalUnitPrice: row.original_unit_price === null ? null : money(Number(row.original_unit_price), currency),
    available: row.available,
  };
}

function toCart(row: Selectable<CartTable>, lines: readonly Selectable<CartLineTable>[]): Cart {
  const amount = (value: string | number) => money(Number(value), row.currency);
  const checkout = toCheckout(row);
  return {
    id: row.id,
    channelId: row.channel_id,
    currency: row.currency,
    lines: lines.map((line) => ({
      ...toLineState(line, row.currency),
      subtotal: amount(line.subtotal),
      total: amount(line.total),
    })),
    subtotal: amount(row.subtotal),
    adjustments: row.adjustments.map((a) => ({ ...a, amount: amount(a.amount) })),
    adjustmentsTotal: amount(row.adjustments_total),
    total: amount(row.total),
    checkoutState: checkout.state,
    email: checkout.email,
    shippingAddress: checkout.shippingAddress,
    billingAddress: checkout.billingAddress,
    shippingMethod: checkout.shipping,
    paymentMethod: checkout.payment,
    orderId: row.order_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
