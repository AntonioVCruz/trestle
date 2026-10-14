import Fastify from 'fastify';
import {
  err,
  money,
  ok,
  type CatalogService,
  type Channel,
  type OrderService,
  type PaymentsService,
  type PricingService,
  type ShippingOption,
  type ShippingService,
} from '@trestle/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminApi } from './index.js';

const notStubbed = (name: string) => () => Promise.reject(new Error(`shipping.${name} is not stubbed`));
const unusedShipping: ShippingService = {
  listOptions: notStubbed('listOptions'),
  getOption: notStubbed('getOption'),
  createOption: notStubbed('createOption'),
  updateOption: notStubbed('updateOption'),
  quotes: notStubbed('quotes'),
};

const channel = { id: 'chn_eu', code: 'eu', currencies: ['EUR', 'USD'] } as unknown as Channel;
const at = new Date('2026-01-01T00:00:00Z');
const option: ShippingOption = {
  id: 'ship_1',
  channelId: 'chn_eu',
  name: 'Standard',
  countries: ['DE', 'AT'],
  active: true,
  prices: [money(495, 'EUR')],
  createdAt: at,
  updatedAt: at,
};

let shipping: ShippingService = unusedShipping;
const calls: { method: string; args: unknown[] }[] = [];
const recordingShipping = Object.fromEntries(
  Object.keys(unusedShipping).map((method) => [
    method,
    (...args: unknown[]) => {
      calls.push({ method, args });
      return (shipping[method as keyof ShippingService] as (...a: unknown[]) => unknown)(...args);
    },
  ]),
) as unknown as ShippingService;

const app = Fastify();
await app.register(adminApi, {
  payments: {} as PaymentsService,
  prefix: '/admin/v1',
  token: 't',
  shipping: recordingShipping,
  catalog: {} as CatalogService,
  pricing: {} as PricingService,
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
beforeEach(() => {
  shipping = unusedShipping;
  calls.length = 0;
});

const headers = { authorization: 'Bearer t' };
const create = (payload: object) => app.inject({ method: 'POST', url: '/admin/v1/shipping-options', headers, payload });

describe('Admin API: shipping options', () => {
  it('lists options, optionally by channel', async () => {
    shipping = { ...unusedShipping, listOptions: async () => [option] };
    const res = await app.inject({ url: '/admin/v1/shipping-options?channelId=chn_eu', headers });
    expect(res.json()).toEqual({
      data: [
        {
          id: 'ship_1',
          channelId: 'chn_eu',
          name: 'Standard',
          countries: ['DE', 'AT'],
          active: true,
          prices: [{ currency: 'EUR', amount: 495 }],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(calls[0]!.args[0]).toEqual({ channelId: 'chn_eu' });
  });

  it('creates options after checking the channel and its currencies', async () => {
    shipping = { ...unusedShipping, createOption: async () => ok(option) };
    const base = { channelId: 'chn_eu', name: 'Standard', prices: [{ currency: 'EUR', amount: 495 }] };

    expect((await create({ ...base, channelId: 'chn_x' })).json().error.code).toBe('channel_not_found');
    expect((await create({ ...base, prices: [{ currency: 'GBP', amount: 1 }] })).json().error.code).toBe(
      'currency_not_in_channel',
    );
    expect(calls).toEqual([]);

    const res = await create({ ...base, countries: ['DE', 'AT'] });
    expect(res.statusCode).toBe(201);
    expect(calls[0]!.args[0]).toEqual({ ...base, countries: ['DE', 'AT'] });
  });

  it('rejects malformed options before reaching the service', async () => {
    const base = { channelId: 'chn_eu', name: 'Standard', prices: [{ currency: 'EUR', amount: 495 }] };
    for (const payload of [
      { ...base, prices: [] },
      { ...base, countries: [] },
      { ...base, countries: ['de'] },
      { ...base, prices: [{ currency: 'EUR', amount: -1 }] },
      { ...base, name: '' },
    ]) {
      expect((await create(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('updates options, checking new prices against the option’s channel', async () => {
    shipping = { ...unusedShipping, getOption: async () => option, updateOption: async () => ok({ ...option, active: false }) };
    const patch = (payload: object, id = 'ship_1') =>
      app.inject({ method: 'PATCH', url: `/admin/v1/shipping-options/${id}`, headers, payload });

    expect((await patch({ prices: [{ currency: 'GBP', amount: 1 }] })).json().error.code).toBe('currency_not_in_channel');
    expect((await patch({ active: false })).json()).toMatchObject({ active: false });
    expect((await patch({ countries: null })).statusCode).toBe(200);
    expect((await patch({})).statusCode).toBe(400);

    shipping = { ...unusedShipping, getOption: async () => undefined, updateOption: async () => err('shipping_option_not_found', 'gone') };
    expect((await patch({ prices: [{ currency: 'EUR', amount: 1 }] }, 'ship_x')).statusCode).toBe(404);
    expect((await patch({ name: 'X' }, 'ship_x')).statusCode).toBe(404);
  });
});
