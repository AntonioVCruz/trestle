import { describe, expect, it } from 'vitest';
import { money } from '../../kernel/money.js';
import { checkPriceListWindow, checkPrices, isListLive, resolvePrice, type PriceCandidate, type PriceContext } from './rules.js';

const now = new Date('2026-06-15T12:00:00Z');
const ctx: PriceContext = { currency: 'EUR', channelId: 'chn_eu', quantity: 1, at: now };

let seq = 0;
function price(amount: number, extra: Partial<Omit<PriceCandidate, 'amount'>> & { currency?: string } = {}): PriceCandidate {
  const { currency = 'EUR', ...rest } = extra;
  return { id: `price_${String(++seq).padStart(3, '0')}`, amount: money(amount, currency), channelId: null, minQuantity: 1, list: null, ...rest };
}

type ListOverrides = Partial<NonNullable<PriceCandidate['list']>>;
const list = (type: 'sale' | 'override', priority: number, extra: ListOverrides) => ({
  id: `plist_${type}_${priority}`,
  type,
  status: 'active' as const,
  priority,
  startsAt: null,
  endsAt: null,
  ...extra,
});
const sale = (priority = 0, extra: ListOverrides = {}) => list('sale', priority, extra);
const override = (priority = 0, extra: ListOverrides = {}) => list('override', priority, extra);

describe('resolvePrice', () => {
  it('returns null when nothing applies', () => {
    expect(resolvePrice([], ctx)).toBeNull();
    expect(resolvePrice([price(1000, { currency: 'USD' })], ctx)).toBeNull();
    expect(resolvePrice([price(1000, { channelId: 'chn_us' })], ctx)).toBeNull();
    expect(resolvePrice([price(1000, { minQuantity: 2 })], ctx)).toBeNull();
  });

  it('prefers a channel-specific base price over an any-channel one', () => {
    const generic = price(1000);
    const eu = price(1200, { channelId: 'chn_eu' });
    expect(resolvePrice([generic, eu], ctx)).toEqual({ priceId: eu.id, amount: eu.amount, priceListId: null, original: null });
  });

  it('applies the highest quantity tier reached', () => {
    const one = price(1000);
    const ten = price(800, { minQuantity: 10 });
    expect(resolvePrice([one, ten], { ...ctx, quantity: 9 })?.priceId).toBe(one.id);
    expect(resolvePrice([one, ten], { ...ctx, quantity: 10 })?.priceId).toBe(ten.id);
  });

  describe('sale lists', () => {
    it('apply when lower than the regular price, which becomes the original', () => {
      const discounted = price(750, { list: sale() });
      expect(resolvePrice([price(1000), discounted], ctx)).toEqual({
        priceId: discounted.id,
        amount: money(750, 'EUR'),
        priceListId: 'plist_sale_0',
        original: money(1000, 'EUR'),
      });
    });

    it('never raise a price', () => {
      const base = price(1000);
      expect(resolvePrice([base, price(1100, { list: sale() })], ctx)).toMatchObject({ priceId: base.id, original: null });
      expect(resolvePrice([base, price(1000, { list: sale() })], ctx)).toMatchObject({ priceId: base.id, original: null });
    });

    it('lose to a cheaper quantity tier', () => {
      // Regular 20.00, 15.00 from ten units; a sale at 18.00 for any quantity.
      const candidates = [price(2000), price(1500, { minQuantity: 10 }), price(1800, { list: sale() })];
      expect(resolvePrice(candidates, { ...ctx, quantity: 1 })).toMatchObject({
        amount: money(1800, 'EUR'),
        original: money(2000, 'EUR'),
      });
      expect(resolvePrice(candidates, { ...ctx, quantity: 10 })).toMatchObject({
        amount: money(1500, 'EUR'),
        priceListId: null,
        original: null,
      });
    });

    it('go to the higher priority among those that undercut', () => {
      const low = price(700, { list: sale(1) });
      const high = price(900, { list: sale(5) });
      const tooHigh = price(1200, { list: sale(9) });
      expect(resolvePrice([price(1000), low, high, tooHigh], ctx)?.priceId).toBe(high.id);
    });

    it('apply without an original when there is no regular price', () => {
      expect(resolvePrice([price(500, { list: sale() })], ctx)).toMatchObject({ amount: money(500, 'EUR'), original: null });
    });
  });

  describe('override lists', () => {
    it('replace the regular price, higher or lower, without an original', () => {
      for (const amount of [800, 1200]) {
        const contract = price(amount, { list: override() });
        expect(resolvePrice([price(1000), contract], ctx)).toEqual({
          priceId: contract.id,
          amount: money(amount, 'EUR'),
          priceListId: 'plist_override_0',
          original: null,
        });
      }
    });

    it('beat base tiers, and the higher priority override wins', () => {
      const low = price(1100, { list: override(1) });
      const high = price(1300, { list: override(2) });
      expect(resolvePrice([price(1000), price(500, { minQuantity: 10 }), low, high], { ...ctx, quantity: 10 })?.priceId).toBe(
        high.id,
      );
    });

    it('set the price a sale must undercut', () => {
      const candidates = [price(1000), price(1300, { list: override() }), price(1200, { list: sale() })];
      expect(resolvePrice(candidates, ctx)).toMatchObject({ amount: money(1200, 'EUR'), original: money(1300, 'EUR') });
    });
  });

  it('ignores draft lists and lists outside their window', () => {
    const base = price(1000);
    const candidates = [
      base,
      price(500, { list: sale(1, { status: 'draft' }) }),
      price(600, { list: sale(2, { startsAt: new Date('2026-07-01T00:00:00Z') }) }),
      price(700, { list: sale(3, { endsAt: now }) }),
      price(800, { list: override(4, { status: 'draft' }) }),
    ];
    expect(resolvePrice(candidates, ctx)?.priceId).toBe(base.id);
  });

  it('breaks remaining ties by lower amount, then id', () => {
    const a = price(1000);
    const b = price(900);
    expect(resolvePrice([a, b], ctx)?.priceId).toBe(b.id);
    const c = price(900);
    expect(resolvePrice([c, b], ctx)?.priceId).toBe(b.id);
  });
});

describe('isListLive', () => {
  it('treats the window as [startsAt, endsAt)', () => {
    const list = sale(0, { startsAt: now, endsAt: new Date('2026-06-16T00:00:00Z') });
    expect(isListLive(list, now)).toBe(true);
    expect(isListLive(list, new Date('2026-06-16T00:00:00Z'))).toBe(false);
    expect(isListLive(list, new Date('2026-06-15T11:59:59Z'))).toBe(false);
  });
});

describe('checkPrices', () => {
  it('accepts distinct scopes', () => {
    expect(
      checkPrices([
        { currency: 'EUR', amount: 1000 },
        { currency: 'EUR', amount: 900, minQuantity: 10 },
        { currency: 'EUR', amount: 1100, channelId: 'chn_eu' },
        { currency: 'USD', amount: 0 },
      ]),
    ).toEqual({ ok: true, value: undefined });
  });

  it.each([
    ['a bad currency', [{ currency: 'eur', amount: 1 }], /currency/],
    ['a fractional amount', [{ currency: 'EUR', amount: 9.99 }], /minor units/],
    ['a negative amount', [{ currency: 'EUR', amount: -1 }], /minor units/],
    ['a zero minimum quantity', [{ currency: 'EUR', amount: 1, minQuantity: 0 }], /quantity/],
    ['a duplicate scope', [{ currency: 'EUR', amount: 1 }, { currency: 'EUR', amount: 2, minQuantity: 1 }], /Duplicate/],
  ])('rejects %s', (_, prices, message) => {
    const result = checkPrices(prices);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(message);
  });
});

describe('checkPriceListWindow', () => {
  it('requires the end to come after the start', () => {
    expect(checkPriceListWindow(now, now).ok).toBe(false);
    expect(checkPriceListWindow(now, null).ok).toBe(true);
    expect(checkPriceListWindow(null, now).ok).toBe(true);
  });
});
