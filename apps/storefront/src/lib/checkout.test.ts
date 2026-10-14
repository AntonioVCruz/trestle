import { describe, expect, it } from 'vitest';
import {
  addressLines,
  afterCompletionError,
  billsToShipping,
  checkoutBlock,
  priceChanges,
  reachableStep,
  readAddressForm,
  shouldRetryCompletion,
} from './checkout.js';
import { countryOptions, isCountryCode } from './countries.js';

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

const shipping = {
  'shipping.firstName': 'Jo',
  'shipping.lastName': 'Rivera',
  'shipping.line1': '12 Main St',
  'shipping.line2': '',
  'shipping.city': 'Oakland',
  'shipping.region': 'CA',
  'shipping.postalCode': '94612',
  'shipping.country': 'US',
  'shipping.phone': '',
};

describe('steps', () => {
  it('lets the shopper go as far as the cart’s checkout state allows', () => {
    expect(reachableStep({ checkoutState: 'cart' })).toBe('address');
    expect(reachableStep({ checkoutState: 'addressed' })).toBe('shipping');
    expect(reachableStep({ checkoutState: 'shipping_selected' })).toBe('payment');
    expect(reachableStep({ checkoutState: 'payment_selected' })).toBe('review');
  });

  it('keeps empty carts, unavailable lines and orders being placed out of checkout', () => {
    const line = (available: boolean) => ({ available }) as never;
    expect(checkoutBlock(null)).toBe('no_cart');
    expect(checkoutBlock({ lines: [], checkoutState: 'cart' })).toBe('no_cart');
    expect(checkoutBlock({ lines: [line(true), line(false)], checkoutState: 'cart' })).toBe('unavailable_lines');
    expect(checkoutBlock({ lines: [line(true)], checkoutState: 'completing' })).toBe('completing');
    expect(checkoutBlock({ lines: [line(true)], checkoutState: 'addressed' })).toBeNull();
  });
});

describe('readAddressForm', () => {
  it('bills to the shipping address when the box is ticked, with empty optional fields as null', () => {
    const result = readAddressForm(form({ email: ' jo@example.com ', ...shipping, billingSame: 'on' }));
    expect(result).toEqual({
      ok: true,
      value: {
        email: 'jo@example.com',
        shippingAddress: { firstName: 'Jo', lastName: 'Rivera', line1: '12 Main St', line2: null, city: 'Oakland', region: 'CA', postalCode: '94612', country: 'US', phone: null },
      },
    });
  });

  it('reads a separate billing address otherwise', () => {
    const billing = Object.fromEntries(Object.entries(shipping).map(([k, v]) => [k.replace('shipping.', 'billing.'), v]));
    const result = readAddressForm(form({ email: 'jo@example.com', ...shipping, ...billing, 'billing.city': 'Berkeley' }));
    expect(result.ok && result.value.billingAddress?.city).toBe('Berkeley');
  });

  it('puts an error next to each field that needs one', () => {
    const result = readAddressForm(form({ email: 'jo@', ...shipping, 'shipping.city': ' ', 'shipping.country': 'XX', billingSame: 'on' }));
    expect(result).toEqual({
      ok: false,
      errors: { email: expect.any(String), 'shipping.city': 'Enter your city', 'shipping.country': 'Choose a country' },
    });
  });
});

describe('addresses', () => {
  const address = { firstName: 'Jo', lastName: 'Rivera', line1: '12 Main St', line2: 'Apt 4', city: 'Oakland', region: 'CA', postalCode: '94612', country: 'US' };

  it('formats an address on three lines, skipping what is empty', () => {
    expect(addressLines(address)).toEqual(['Jo Rivera', '12 Main St, Apt 4', 'Oakland, CA 94612, US']);
    expect(addressLines({ ...address, line2: null, region: null })).toEqual(['Jo Rivera', '12 Main St', 'Oakland, 94612, US']);
  });

  it('knows when billing goes to the shipping address', () => {
    const full = { ...address, company: null, phone: null };
    expect(billsToShipping({ shippingAddress: full, billingAddress: null })).toBe(true);
    expect(billsToShipping({ shippingAddress: full, billingAddress: { ...full } })).toBe(true);
    expect(billsToShipping({ shippingAddress: full, billingAddress: { ...full, city: 'Berkeley' } })).toBe(false);
  });

  it('names countries in the shopper’s language', () => {
    expect(isCountryCode('US')).toBe(true);
    expect(isCountryCode('XX')).toBe(false);
    expect(countryOptions('en').find((c) => c.code === 'DE')?.name).toBe('Germany');
  });
});

describe('placing the order', () => {
  it('retries network errors, 5xx and a completion already in progress, nothing else', () => {
    expect(shouldRetryCompletion(0, null)).toBe(true);
    expect(shouldRetryCompletion(502, 'payment_provider_failed')).toBe(true);
    expect(shouldRetryCompletion(409, 'completion_in_progress')).toBe(true);
    expect(shouldRetryCompletion(402, 'payment_declined')).toBe(false);
    expect(shouldRetryCompletion(409, 'cart_changed')).toBe(false);
  });

  it('sends each failure to the screen that handles it', () => {
    expect(afterCompletionError('payment_declined')).toBe('/checkout/payment?error=payment_declined');
    expect(afterCompletionError('payment_requires_action')).toBe('/checkout/confirm-payment');
    expect(afterCompletionError('cart_changed')).toBe('/checkout/review?changed=1');
    expect(afterCompletionError('cart_not_ready')).toBe('/cart?error=cart_not_ready');
    expect(afterCompletionError('something_new')).toBe('/checkout/review?error=something_new');
  });

  it('finds the lines whose price changed at review (3d)', () => {
    const line = (id: string, unitPrice: number, quantity = 2) =>
      ({ id, productTitle: 'Linen Tee', variantTitle: 'M / Red', unitPrice, total: unitPrice * quantity }) as never;
    expect(priceChanges({ lines: [line('a', 2800), line('b', 5000)] }, { lines: [line('a', 3000), line('b', 5000)] })).toEqual([
      { lineId: 'a', title: 'Linen Tee — M / Red', unitBefore: 2800, unitAfter: 3000, totalBefore: 5600 },
    ]);
  });
});
