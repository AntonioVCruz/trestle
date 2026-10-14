import { pino } from 'pino';
import type { Core } from '@trestle/core';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { paymentProviders, warnAboutPaymentProviders } from './roles.js';

const env = { DATABASE_URL: 'postgres://localhost/x' };

describe('the test payment provider flag (ADR 0019)', () => {
  it('is off unless set to true', () => {
    expect(loadConfig(env).enableTestPaymentProvider).toBe(false);
    expect(loadConfig({ ...env, ENABLE_TEST_PAYMENT_PROVIDER: 'false' }).enableTestPaymentProvider).toBe(false);
    expect(loadConfig({ ...env, ENABLE_TEST_PAYMENT_PROVIDER: 'true' }).enableTestPaymentProvider).toBe(true);
    expect(loadConfig({ ...env, ENABLE_TEST_PAYMENT_PROVIDER: ' TRUE ' }).enableTestPaymentProvider).toBe(true);
  });

  it('refuses values that are probably a mistake', () => {
    for (const value of ['1', 'yes', 'on']) {
      expect(() => loadConfig({ ...env, ENABLE_TEST_PAYMENT_PROVIDER: value })).toThrow(/must be "true" or "false"/);
    }
  });

  it('decides whether the test provider is registered', () => {
    expect(paymentProviders({ enableTestPaymentProvider: false })).toEqual([]);
    expect(paymentProviders({ enableTestPaymentProvider: true }).map((p) => p.id)).toEqual(['test']);
  });

  it('warns about test-mode providers and channels enabling unregistered ones', async () => {
    const lines: { msg: string; provider: string }[] = [];
    const logger = pino({ level: 'warn' }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    const payments = {
      listProviders: async () => [
        { id: 'test', name: 'Test', supportsDeferredCapture: true, testMode: true, channels: [] },
        { id: 'live', name: 'Live', supportsDeferredCapture: true, testMode: false, channels: [] },
      ],
      unregisteredProviders: async () => [{ providerId: 'old', channelIds: ['chn_eu'] }],
    } as unknown as Core['payments'];

    await warnAboutPaymentProviders({ payments }, logger);
    expect(lines.map((l) => [l.provider, l.msg])).toEqual([
      ['test', expect.stringMatching(/moves no money/)],
      ['old', expect.stringMatching(/not registered/)],
    ]);
  });
});
