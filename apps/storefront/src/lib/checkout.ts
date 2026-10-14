import { lineTitle, unavailableLines } from './cart.js';
import { isCountryCode } from './countries.js';
import type { Address, Cart } from './types.js';

/**
 * Checkout rules (wireframes 1q–1x, 3c–3g; ADR 0016, ADR 0018). Four steps, each with its own
 * URL; the cart's checkout state says how far the shopper may go.
 */

export const STEPS = [
  { step: 'address', label: 'Address' },
  { step: 'shipping', label: 'Shipping' },
  { step: 'payment', label: 'Payment' },
  { step: 'review', label: 'Review' },
] as const;
export type Step = (typeof STEPS)[number]['step'];

const REACHABLE: Record<Cart['checkoutState'], Step> = {
  cart: 'address',
  addressed: 'shipping',
  shipping_selected: 'payment',
  payment_selected: 'review',
  completing: 'review',
  placed: 'review',
};

export const stepIndex = (step: Step) => STEPS.findIndex((s) => s.step === step);

/** The furthest step the cart allows: each needs the ones before it done. */
export function reachableStep(cart: Pick<Cart, 'checkoutState'>): Step {
  return REACHABLE[cart.checkoutState];
}

export type CheckoutBlock = 'no_cart' | 'unavailable_lines' | 'completing';

/**
 * Why the shopper cannot be in checkout right now, if anything: an empty cart, lines that can
 * no longer be bought (3b), or an order already being placed (3e).
 */
export function checkoutBlock(cart: Pick<Cart, 'lines' | 'checkoutState'> | null): CheckoutBlock | null {
  if (!cart || cart.lines.length === 0) return 'no_cart';
  if (unavailableLines(cart).length > 0) return 'unavailable_lines';
  if (cart.checkoutState === 'completing') return 'completing';
  return null;
}

// --- Step 1: the address form ----------------------------------------------------------------

export const ADDRESS_FIELDS = ['firstName', 'lastName', 'line1', 'line2', 'city', 'region', 'postalCode', 'country', 'phone'] as const;
type AddressField = (typeof ADDRESS_FIELDS)[number];
const REQUIRED: readonly AddressField[] = ['firstName', 'lastName', 'line1', 'city', 'postalCode', 'country'];
const MAX_LENGTH = 200;

/** What POST /carts/{id}/addresses takes; optional fields are null when left empty. */
export interface AddressInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly region: string | null;
  readonly postalCode: string;
  readonly country: string;
  readonly phone: string | null;
}

export interface AddressesInput {
  readonly email: string;
  readonly shippingAddress: AddressInput;
  readonly billingAddress?: AddressInput;
}

export type AddressFormResult =
  | { readonly ok: true; readonly value: AddressesInput }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

const LABELS: Record<AddressField, string> = {
  firstName: 'first name',
  lastName: 'last name',
  line1: 'address',
  line2: 'apartment or suite',
  city: 'city',
  region: 'region',
  postalCode: 'postal code',
  country: 'country',
  phone: 'phone number',
};

/** Field names in the form: `email`, `shipping.city`, `billing.city`, … */
export const fieldName = (section: 'shipping' | 'billing', field: AddressField) => `${section}.${field}`;

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

function readAddress(form: FormData, section: 'shipping' | 'billing', errors: Record<string, string>): AddressInput {
  const values = Object.fromEntries(ADDRESS_FIELDS.map((f) => [f, text(form, fieldName(section, f))])) as Record<AddressField, string>;
  for (const field of ADDRESS_FIELDS) {
    const name = fieldName(section, field);
    if (REQUIRED.includes(field) && values[field] === '') errors[name] = `Enter your ${LABELS[field]}`;
    else if (values[field].length > MAX_LENGTH) errors[name] = `Use at most ${MAX_LENGTH} characters`;
  }
  if (values.country !== '' && !isCountryCode(values.country)) errors[fieldName(section, 'country')] = 'Choose a country';
  const optional = (v: string) => (v === '' ? null : v);
  return { ...values, line2: optional(values.line2), region: optional(values.region), phone: optional(values.phone) };
}

/**
 * Reads and checks step 1 before it reaches the API, so errors can sit next to their fields
 * (1r). The billing address is read only when it differs from the shipping address.
 */
export function readAddressForm(form: FormData): AddressFormResult {
  const errors: Record<string, string> = {};
  const email = text(form, 'email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) errors.email = 'Enter an email address like jo@example.com';
  const shippingAddress = readAddress(form, 'shipping', errors);
  const billingAddress = form.has('billingSame') ? undefined : readAddress(form, 'billing', errors);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { email, shippingAddress, ...(billingAddress ? { billingAddress } : {}) } };
}

/** "Jo Rivera", "12 Main St, Apt 4", "Oakland, CA 94612, US". */
export function addressLines(address: Pick<Address, 'firstName' | 'lastName' | 'line1' | 'line2' | 'city' | 'region' | 'postalCode' | 'country'>): string[] {
  const place = [address.city, [address.region, address.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [`${address.firstName} ${address.lastName}`, [address.line1, address.line2].filter(Boolean).join(', '), `${place}, ${address.country}`];
}

/** Whether billing goes to the shipping address; the API stores both even when they are the same. */
export function billsToShipping(cart: Pick<Cart, 'shippingAddress' | 'billingAddress'>): boolean {
  return cart.billingAddress === null || JSON.stringify(cart.billingAddress) === JSON.stringify(cart.shippingAddress);
}

// --- Placing the order -----------------------------------------------------------------------

/**
 * Whether to retry POST /complete with the same Idempotency-Key: network errors (status 0),
 * 5xx and `completion_in_progress`. Anything else is an answer (ADR 0018).
 */
export function shouldRetryCompletion(status: number, code: string | null): boolean {
  return status === 0 || status >= 500 || code === 'completion_in_progress';
}

/** Where a failed attempt to place the order sends the shopper, by error code. */
export function afterCompletionError(code: string): string {
  switch (code) {
    case 'payment_declined':
    case 'payment_session_unusable':
    case 'payment_amount_mismatch':
    case 'payment_session_not_found':
    case 'payment_required':
      return `/checkout/payment?error=${code}`; // 1w: back to step 3, cart intact
    case 'payment_requires_action':
      return '/checkout/confirm-payment'; // 3c
    case 'cart_changed':
      return '/checkout/review?changed=1'; // 3d
    case 'shipping_option_unavailable':
      return `/checkout/shipping?error=${code}`;
    case 'cart_not_ready':
    case 'variant_not_available':
    case 'variant_not_priced':
    case 'cart_empty':
      return `/cart?error=${code}`;
    default:
      return `/checkout/review?error=${code}`;
  }
}

/** What to tell the shopper about a checkout error, by Store API error code. */
export function checkoutErrorMessage(code: string): { readonly title: string; readonly body: string } {
  switch (code) {
    case 'payment_declined':
      return {
        title: 'Your payment didn’t go through',
        body: 'The payment was declined and you haven’t been charged. Your cart is saved: try again or choose another payment method.',
      };
    case 'payment_action_failed':
      return {
        title: 'Your payment wasn’t confirmed',
        body: 'You haven’t been charged. Your cart is saved: try again or choose another payment method.',
      };
    case 'payment_session_unusable':
    case 'payment_amount_mismatch':
    case 'payment_session_not_found':
    case 'payment_required':
      return { title: 'Choose your payment again', body: 'Your payment needs to be set up again before you place the order. You haven’t been charged.' };
    case 'shipping_option_unavailable':
      return { title: 'That delivery option is no longer available', body: 'Choose another way to get your order.' };
    case 'not_placed':
      return { title: 'Your order wasn’t placed', body: 'You haven’t been charged. Check the details below and try again.' };
    case 'cart_changed':
      return { title: 'Your cart changed', body: 'Check the new total, then continue. You haven’t been charged.' };
    default:
      return { title: 'Something went wrong', body: 'We couldn’t complete that step. Please try again; you haven’t been charged.' };
  }
}

// --- 3d: prices changed at review -------------------------------------------------------------

export interface PriceChange {
  readonly lineId: string;
  readonly title: string;
  readonly unitBefore: number;
  readonly unitAfter: number;
  readonly totalBefore: number;
}

/**
 * What changed between the cart the shopper reviewed and the re-priced one (3d). The API does
 * not say, so the storefront compares the two.
 */
export function priceChanges(before: Pick<Cart, 'lines'>, after: Pick<Cart, 'lines'>): PriceChange[] {
  return after.lines.flatMap((line) => {
    const old = before.lines.find((l) => l.id === line.id);
    if (!old || old.unitPrice === line.unitPrice) return [];
    return [{ lineId: line.id, title: lineTitle(line), unitBefore: old.unitPrice, unitAfter: line.unitPrice, totalBefore: old.total }];
  });
}
