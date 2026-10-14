import Fastify from 'fastify';
import {
  err,
  ok,
  type CatalogService,
  type Channel,
  type OrderService,
  type PaymentsService,
  type PricingService,
  type SetProviderChannelInput,
  type ShippingService,
} from '@trestle/core';
import { afterAll, describe, expect, it } from 'vitest';
import { adminApi } from './index.js';

const channel = { id: 'chn_eu' } as Channel;
const setCalls: unknown[][] = [];

const info = (channels: readonly SetProviderChannelInput[]) => ({
  id: 'test',
  name: 'Test payments',
  supportsDeferredCapture: true,
  testMode: true,
  channels: channels.map((c) => ({ channelId: c.channelId, captureMode: c.captureMode ?? 'immediate' })),
});

const payments = {
  listProviders: async () => [info([{ channelId: 'chn_eu' }])],
  setProviderChannels: async (providerId: string, channels: readonly SetProviderChannelInput[]) => {
    setCalls.push([providerId, channels]);
    if (providerId === 'stub') return err('deferred_capture_unsupported', 'Stub can only capture immediately');
    return providerId === 'test' ? ok(info(channels)) : err('payment_provider_not_found', `Payment provider "${providerId}" is not registered`);
  },
} as unknown as PaymentsService;

const app = Fastify();
await app.register(adminApi, {
  prefix: '/admin/v1',
  token: 't',
  payments,
  catalog: {} as CatalogService,
  pricing: {} as PricingService,
  shipping: {} as ShippingService,
  orders: {} as OrderService,
  channels: {
    list: async () => [],
    getById: async (id) => (id === channel.id ? channel : undefined),
    getByPublishableKey: async () => undefined,
    create: async () => err('invalid_input', 'unused'),
    createPublishableKey: async () => err('channel_not_found', 'unused'),
  },
});
await app.ready();
afterAll(() => app.close());

const headers = { authorization: 'Bearer t' };
const put = (id: string, channels: { channelId: string; captureMode?: string }[]) =>
  app.inject({ method: 'PUT', url: `/admin/v1/payment-providers/${id}/channels`, headers, payload: { channels } });

describe('Admin API: payment providers', () => {
  it('lists registered providers with their channels, capture modes and test mode', async () => {
    const res = await app.inject({ url: '/admin/v1/payment-providers', headers });
    expect(res.json()).toEqual({
      data: [
        {
          id: 'test',
          name: 'Test payments',
          supportsDeferredCapture: true,
          testMode: true,
          channels: [{ channelId: 'chn_eu', captureMode: 'immediate' }],
        },
      ],
    });
  });

  it('enables a provider in existing channels only, capturing immediately by default', async () => {
    const unknown = await put('test', [{ channelId: 'chn_eu' }, { channelId: 'chn_x' }]);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('channel_not_found');
    expect(setCalls).toEqual([]);

    const res = await put('test', [{ channelId: 'chn_eu' }]);
    expect(res.json()).toMatchObject({ id: 'test', channels: [{ channelId: 'chn_eu', captureMode: 'immediate' }] });
    expect(setCalls.at(-1)).toEqual(['test', [{ channelId: 'chn_eu', captureMode: 'immediate' }]]);
    expect((await put('test', [{ channelId: 'chn_eu', captureMode: 'manual' }])).json()).toMatchObject({
      channels: [{ captureMode: 'manual' }],
    });
    expect((await put('test', [])).statusCode).toBe(200);
    expect((await put('test', [{ channelId: 'chn_eu', captureMode: 'later' }])).statusCode).toBe(400);
  });

  it('returns 404 for providers that are not registered, 409 when manual capture is unsupported', async () => {
    const res = await put('stripe', [{ channelId: 'chn_eu' }]);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('payment_provider_not_found');
    const manual = await put('stub', [{ channelId: 'chn_eu', captureMode: 'manual' }]);
    expect(manual.statusCode).toBe(409);
    expect(manual.json().error.code).toBe('deferred_capture_unsupported');
  });
});
