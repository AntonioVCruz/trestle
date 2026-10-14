import { pino } from 'pino';
import { createCore, createDatabase } from '@trestle/core';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const db = createDatabase('postgres://unused@localhost/unused');
afterAll(() => db.destroy());

describe('web app', () => {
  it('reports liveness and readiness', async () => {
    let dbUp = true;
    const app = await buildApp({
      core: createCore(db),
      adminApiToken: 't',
      checkReady: async () => {
        if (!dbUp) throw new Error('db down');
      },
    });
    expect((await app.inject({ url: '/health/live' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(200);
    dbUp = false;
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(503);
    await app.close();
  });

  it('accepts the shared pino logger used by the web role', async () => {
    const app = await buildApp({
      core: createCore(db),
      adminApiToken: 't',
      checkReady: async () => {},
      logger: pino({ level: 'silent' }),
    });
    expect((await app.inject({ url: '/health/live' })).statusCode).toBe(200);
    await app.close();
  });

  it('keeps the Store and Admin OpenAPI documents disjoint', async () => {
    const app = await buildApp({ core: createCore(db), adminApiToken: undefined, checkReady: async () => {} });
    const store = (await app.inject({ url: '/store/v1/openapi.json' })).json();
    const admin = (await app.inject({ url: '/admin/v1/openapi.json' })).json();
    expect(Object.keys(store.paths).every((p) => p.startsWith('/store/v1/'))).toBe(true);
    expect(Object.keys(admin.paths).every((p) => p.startsWith('/admin/v1/'))).toBe(true);
    expect(Object.keys(admin.paths).length).toBeGreaterThan(0);
    await app.close();
  });
});
