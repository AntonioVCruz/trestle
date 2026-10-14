import { describe, expect, it } from 'vitest';
import { money } from '../../kernel/money.js';
import { computeTotals } from '../../kernel/totals.js';
import {
  applyShippingQuote,
  checkAddress,
  choosePayment,
  chooseShipping,
  EMPTY_CHECKOUT,
  enterAddresses,
  isLocked,
  reconcilePayment,
  shippingAdjuster,
  type AddressInput,
  type CheckoutData,
} from './checkout.js';

const home: AddressInput = {
  firstName: ' Ada ',
  lastName: 'Lovelace',
  line1: '1 Main St',
  city: 'Berlin',
  postalCode: '10115',
  country: 'DE',
};
const office: AddressInput = { ...home, line1: '2 Work Rd' };
const quote = { optionId: 'ship_1', name: 'Standard', amount: money(495, 'EUR') };

function addressed(overrides: Partial<CheckoutData> = {}): CheckoutData {
  const result = enterAddresses(EMPTY_CHECKOUT, { email: 'ada@example.com', shippingAddress: home }, true);
  if (!result.ok) throw new Error(result.error.message);
  return { ...result.value, ...overrides };
}

describe('checkAddress', () => {
  it('trims fields and fills optional ones with null', () => {
    expect(checkAddress({ ...home, line2: '  ', phone: ' +49 30 ' }, 'Shipping')).toEqual({
      ok: true,
      value: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        company: null,
        line1: '1 Main St',
        line2: null,
        city: 'Berlin',
        postalCode: '10115',
        region: null,
        country: 'DE',
        phone: '+49 30',
      },
    });
  });

  it.each([
    ['an empty required field', { ...home, city: '  ' }, /city/],
    ['a lowercase country', { ...home, country: 'de' }, /country/],
    ['a three-letter country', { ...home, country: 'DEU' }, /country/],
    ['an overlong field', { ...home, lastName: 'x'.repeat(201) }, /last name/],
  ])('rejects %s', (_, input, message) => {
    const result = checkAddress(input, 'Shipping');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(message);
  });
});

describe('enterAddresses', () => {
  it('moves a cart to addressed, normalizing the email and defaulting billing to shipping', () => {
    const result = enterAddresses(EMPTY_CHECKOUT, { email: ' Ada@Example.COM ', shippingAddress: home }, true);
    expect(result).toMatchObject({ ok: true, value: { state: 'addressed', email: 'ada@example.com' } });
    expect(result.ok && result.value.billingAddress).toEqual(result.ok && result.value.shippingAddress);
  });

  it('keeps a separate billing address', () => {
    const result = enterAddresses(EMPTY_CHECKOUT, { email: 'a@b.co', shippingAddress: home, billingAddress: office }, true);
    expect(result.ok && result.value.billingAddress?.line1).toBe('2 Work Rd');
  });

  it('refuses empty carts and bad emails', () => {
    expect(enterAddresses(EMPTY_CHECKOUT, { email: 'a@b.co', shippingAddress: home }, false)).toMatchObject({
      ok: false,
      error: { code: 'cart_empty' },
    });
    for (const email of ['nope', 'a@b', 'a b@c.de']) {
      expect(enterAddresses(EMPTY_CHECKOUT, { email, shippingAddress: home }, true)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
    }
  });

  it('drops the shipping method when the shipping address changes, and only then', () => {
    const shipped = addressed({ state: 'shipping_selected', shipping: quote });

    const sameAddress = enterAddresses(shipped, { email: 'new@example.com', shippingAddress: home, billingAddress: office }, true);
    expect(sameAddress).toMatchObject({ ok: true, value: { state: 'shipping_selected', shipping: quote, email: 'new@example.com' } });

    const moved = enterAddresses(shipped, { email: 'ada@example.com', shippingAddress: office }, true);
    expect(moved).toMatchObject({ ok: true, value: { state: 'addressed', shipping: null } });
  });

  it('refuses changes once completion has started', () => {
    for (const state of ['completing', 'placed'] as const) {
      expect(isLocked(state)).toBe(true);
      expect(enterAddresses(addressed({ state }), { email: 'a@b.co', shippingAddress: home }, true)).toMatchObject({
        ok: false,
        error: { code: 'cart_locked' },
      });
    }
  });
});

describe('chooseShipping and applyShippingQuote', () => {
  it('needs an address first', () => {
    expect(chooseShipping(EMPTY_CHECKOUT)).toMatchObject({ ok: false, error: { code: 'address_required' } });
    expect(chooseShipping(addressed({ state: 'completing' }))).toMatchObject({ ok: false, error: { code: 'cart_locked' } });
  });

  it('attaches the quote of a newly chosen option, and refuses one that cannot be quoted', () => {
    const chosen = chooseShipping(addressed());
    if (!chosen.ok) throw new Error('chooseShipping');
    expect(chosen.value.state).toBe('shipping_selected');
    expect(applyShippingQuote(chosen.value, 'ship_1', quote)).toMatchObject({ ok: true, value: { shipping: quote } });
    expect(applyShippingQuote(chosen.value, 'ship_1', undefined)).toMatchObject({
      ok: false,
      error: { code: 'shipping_option_unavailable' },
    });
  });

  it('re-prices a chosen option, or drops it back to addressed when it disappears', () => {
    const shipped = addressed({ state: 'shipping_selected', shipping: quote });
    const repriced = { ...quote, amount: money(595, 'EUR') };
    expect(applyShippingQuote(shipped, undefined, repriced)).toMatchObject({ ok: true, value: { shipping: repriced } });
    expect(applyShippingQuote(shipped, undefined, undefined)).toMatchObject({
      ok: true,
      value: { state: 'addressed', shipping: null },
    });
    expect(applyShippingQuote(addressed(), undefined, undefined)).toMatchObject({ ok: true, value: { state: 'addressed' } });
  });
});

describe('shippingAdjuster', () => {
  it('adds the shipping price as an order-level charge', () => {
    const totals = computeTotals(
      { currency: 'EUR', lines: [{ id: 'l1', unitPrice: money(1000, 'EUR'), quantity: 2 }] },
      [shippingAdjuster(quote)],
    );
    expect(totals.adjustments).toEqual([
      { kind: 'shipping', label: 'Standard', amount: money(495, 'EUR'), target: { type: 'order' }, source: 'core.shipping' },
    ]);
    expect(totals.total).toEqual(money(2495, 'EUR'));
  });
});

describe('payment step', () => {
  const payment = { providerId: 'test', name: 'Test payments', sessionId: 'pays_1', amount: money(2495, 'EUR'), clientData: {} };

  it('needs a shipping method first', () => {
    expect(choosePayment(addressed())).toMatchObject({ ok: false, error: { code: 'shipping_required' } });
    expect(choosePayment(addressed({ state: 'shipping_selected', shipping: quote }))).toMatchObject({
      ok: true,
      value: { state: 'payment_selected' },
    });
    expect(choosePayment(addressed({ state: 'completing', shipping: quote }))).toMatchObject({
      ok: false,
      error: { code: 'cart_locked' },
    });
  });

  it('keeps a payment while the total it was prepared for holds', () => {
    const paid = addressed({ state: 'payment_selected', shipping: quote, payment });
    expect(reconcilePayment(paid, money(2495, 'EUR'))).toBe(paid);
  });

  it('drops the payment when the total changes, back to the shipping step', () => {
    const paid = addressed({ state: 'payment_selected', shipping: quote, payment });
    expect(reconcilePayment(paid, money(2995, 'EUR'))).toMatchObject({ state: 'shipping_selected', payment: null });
  });

  it('drops the payment when an earlier step was undone in the same change', () => {
    const undone = addressed({ state: 'addressed', shipping: null, payment });
    expect(reconcilePayment(undone, money(2495, 'EUR'))).toMatchObject({ state: 'addressed', payment: null });
  });
});
