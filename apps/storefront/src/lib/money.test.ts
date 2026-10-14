import { describe, expect, it } from 'vitest';
import { currencyLabel, formatMoney } from './money.js';

describe('currencyLabel', () => {
  it('pairs the code with its symbol, when there is one', () => {
    expect(currencyLabel('USD', 'en')).toBe('USD $');
    expect(currencyLabel('EUR', 'en')).toBe('EUR €');
    expect(currencyLabel('CHF', 'en')).toBe('CHF');
  });
});

describe('formatMoney', () => {
  it('formats minor units with the currency’s own number of decimals', () => {
    expect(formatMoney(2800, 'USD', 'en')).toBe('$28.00');
    expect(formatMoney(2800, 'JPY', 'en')).toBe('¥2,800');
    expect(formatMoney(12345, 'KWD', 'en')).toBe('KWD 12.345');
  });

  it('follows the locale (Intl separates with no-break spaces)', () => {
    expect(formatMoney(2850, 'EUR', 'de')).toBe('28,50 €');
  });

  it('drops a zero fraction only when compact', () => {
    expect(formatMoney(2400, 'USD', 'en', { compact: true })).toBe('$24');
    expect(formatMoney(2450, 'USD', 'en', { compact: true })).toBe('$24.50');
  });
});
