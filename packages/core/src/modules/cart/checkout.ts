import type { Money } from '../../kernel/money.js';
import { err, ok, type DomainError, type Result } from '../../kernel/result.js';
import type { Adjuster } from '../../kernel/totals.js';
import { checkoutStateMachine, type CheckoutState } from '../checkout/index.js';

/**
 * Checkout steps on a cart (ADR 0005, ADR 0016). The cart holds the data each step collects;
 * the checkout state machine decides which step may follow which.
 */

export interface Address {
  readonly firstName: string;
  readonly lastName: string;
  readonly company: string | null;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly postalCode: string;
  readonly region: string | null;
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
  readonly phone: string | null;
}

export type AddressInput = Omit<Address, 'company' | 'line2' | 'region' | 'phone'> &
  Partial<Pick<Address, 'company' | 'line2' | 'region' | 'phone'>>;

export interface ShippingQuote {
  readonly optionId: string;
  readonly name: string;
  readonly amount: Money;
}

/** The chosen payment method, prepared with the provider for exactly `amount`. */
export interface SelectedPayment {
  readonly providerId: string;
  readonly name: string;
  readonly sessionId: string;
  readonly amount: Money;
  /** From the provider, for the storefront's payment form. */
  readonly clientData: Readonly<Record<string, unknown>>;
}

export interface CheckoutData {
  readonly state: CheckoutState;
  readonly email: string | null;
  readonly shippingAddress: Address | null;
  readonly billingAddress: Address | null;
  /** The chosen shipping option, priced for this cart. */
  readonly shipping: ShippingQuote | null;
  readonly payment: SelectedPayment | null;
}

export const EMPTY_CHECKOUT: CheckoutData = {
  state: checkoutStateMachine.initial,
  email: null,
  shippingAddress: null,
  billingAddress: null,
  shipping: null,
  payment: null,
};

/** Once completion starts, the cart is frozen until it is placed or rolled back (ADR 0005). */
const LOCKED: readonly CheckoutState[] = ['completing', 'placed'];

export function isLocked(state: CheckoutState): boolean {
  return LOCKED.includes(state);
}

export type InvalidInput = DomainError<'invalid_input'>;
export type CartLocked = DomainError<'cart_locked'>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY = /^[A-Z]{2}$/;
const MAX_FIELD = 200;

export function checkAddress(input: AddressInput, label: string): Result<Address, InvalidInput> {
  const required = (value: string, field: string): Result<string, InvalidInput> => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_FIELD) {
      return err('invalid_input', `${label} ${field} must be 1 to ${MAX_FIELD} characters`);
    }
    return ok(trimmed);
  };
  const optional = (value: string | null | undefined) => value?.trim().slice(0, MAX_FIELD) || null;

  const fields = {
    firstName: required(input.firstName, 'first name'),
    lastName: required(input.lastName, 'last name'),
    line1: required(input.line1, 'address line'),
    city: required(input.city, 'city'),
    postalCode: required(input.postalCode, 'postal code'),
  };
  for (const result of Object.values(fields)) if (!result.ok) return result;
  if (!COUNTRY.test(input.country)) return err('invalid_input', `${label} country must be an ISO 3166-1 alpha-2 code`);

  const value = (r: Result<string, InvalidInput>) => (r.ok ? r.value : '');
  // Fixed key order, so equal addresses serialize identically.
  return ok({
    firstName: value(fields.firstName),
    lastName: value(fields.lastName),
    company: optional(input.company),
    line1: value(fields.line1),
    line2: optional(input.line2),
    city: value(fields.city),
    postalCode: value(fields.postalCode),
    region: optional(input.region),
    country: input.country,
    phone: optional(input.phone),
  });
}

export interface AddressesInput {
  readonly email: string;
  readonly shippingAddress: AddressInput;
  /** Defaults to the shipping address. */
  readonly billingAddress?: AddressInput | null;
}

/**
 * The address step. Changing the shipping address drops a chosen shipping method, because what
 * ships where and at what price depends on it; changing only the email or billing address keeps
 * the cart where it was.
 */
export function enterAddresses(
  checkout: CheckoutData,
  input: AddressesInput,
  hasAvailableLines: boolean,
): Result<CheckoutData, InvalidInput | CartLocked | DomainError<'cart_empty'>> {
  if (!checkoutStateMachine.can(checkout.state, 'addressed')) {
    return err('cart_locked', 'The cart is being completed and cannot change');
  }
  if (!hasAvailableLines) return err('cart_empty', 'Add something to the cart before checking out');

  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return err('invalid_input', 'Invalid email address');
  const shipping = checkAddress(input.shippingAddress, 'Shipping');
  if (!shipping.ok) return shipping;
  const billing = input.billingAddress ? checkAddress(input.billingAddress, 'Billing') : shipping;
  if (!billing.ok) return billing;

  const moved = JSON.stringify(shipping.value) !== JSON.stringify(checkout.shippingAddress);
  return ok({
    ...checkout,
    state: moved || checkout.state === 'cart' ? 'addressed' : checkout.state,
    email,
    shippingAddress: shipping.value,
    billingAddress: billing.value,
    shipping: moved ? null : checkout.shipping,
  });
}

/** The shipping step. The option's price is attached by `applyShippingQuote`. */
export function chooseShipping(
  checkout: CheckoutData,
): Result<CheckoutData, CartLocked | DomainError<'address_required'>> {
  if (!checkout.shippingAddress) return err('address_required', 'Enter a shipping address first');
  if (!checkoutStateMachine.can(checkout.state, 'shipping_selected')) {
    return err('cart_locked', 'The cart is being completed and cannot change');
  }
  return ok({ ...checkout, state: 'shipping_selected' });
}

/** The option to price on this change: the one just chosen, else the one already chosen. */
export function optionToQuote(checkout: CheckoutData, chosenOptionId: string | undefined): string | undefined {
  return chosenOptionId ?? checkout.shipping?.optionId;
}

/**
 * Re-prices the shipping option on every cart change, like lines. A newly chosen option that
 * cannot be quoted is an error. A previously chosen one that stopped being available is dropped,
 * and the cart goes back to the shipping step.
 */
export function applyShippingQuote(
  checkout: CheckoutData,
  chosenOptionId: string | undefined,
  quote: ShippingQuote | undefined,
): Result<CheckoutData, DomainError<'shipping_option_unavailable'>> {
  const optionId = optionToQuote(checkout, chosenOptionId);
  if (!optionId) return ok(checkout);
  if (quote) return ok({ ...checkout, shipping: quote });
  if (chosenOptionId) {
    return err('shipping_option_unavailable', `Shipping option "${chosenOptionId}" is not available for this cart`);
  }
  const state = checkout.state === 'shipping_selected' || checkout.state === 'payment_selected' ? 'addressed' : checkout.state;
  return ok({ ...checkout, state, shipping: null });
}

/** The payment step. Shipping must be chosen first, since every cart ships (ADR 0016). */
export function choosePayment(
  checkout: CheckoutData,
): Result<CheckoutData, CartLocked | DomainError<'shipping_required'>> {
  if (isLocked(checkout.state)) return err('cart_locked', 'The cart is being completed and cannot change');
  if (!checkout.shipping || !checkoutStateMachine.can(checkout.state, 'payment_selected')) {
    return err('shipping_required', 'Choose a shipping method first');
  }
  return ok({ ...checkout, state: 'payment_selected' });
}

/**
 * A payment is prepared for one amount. When the total changes, or an earlier step is undone,
 * the payment choice is dropped and the cart goes back to the shipping step (or wherever the
 * change already sent it), so no session is ever used for a different amount.
 */
export function reconcilePayment(checkout: CheckoutData, total: Money): CheckoutData {
  if (!checkout.payment) return checkout;
  if (checkout.state === 'payment_selected' && checkout.payment.amount.amount === total.amount) return checkout;
  return { ...checkout, payment: null, state: checkout.state === 'payment_selected' ? 'shipping_selected' : checkout.state };
}

export const SHIPPING_ADJUSTER_ID = 'core.shipping';

/** The chosen shipping method as an order-level charge (ADR 0006): after promotions, before tax. */
export function shippingAdjuster(shipping: ShippingQuote): Adjuster {
  return {
    id: SHIPPING_ADJUSTER_ID,
    priority: 200,
    adjust: () => [{ kind: 'shipping', label: shipping.name, amount: shipping.amount, target: { type: 'order' } }],
  };
}
