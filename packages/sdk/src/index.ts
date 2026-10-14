import createClient from 'openapi-fetch';
import type { paths as AdminPaths } from './generated/admin.js';
import type { paths as StorePaths } from './generated/store.js';

/**
 * Thin typed clients over the published OpenAPI documents (ADR 0003). The reference storefront
 * and admin use these and nothing else, so anything they can do, third parties can too.
 * Regenerate with `npm run generate` after changing an API.
 */

export interface StoreClientOptions {
  readonly baseUrl: string;
  readonly publishableKey: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function createStoreClient({ baseUrl, publishableKey, fetch }: StoreClientOptions) {
  return createClient<StorePaths>({
    baseUrl,
    headers: { 'x-publishable-key': publishableKey },
    ...(fetch ? { fetch } : {}),
  });
}

export interface AdminClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function createAdminClient({ baseUrl, token, fetch }: AdminClientOptions) {
  return createClient<AdminPaths>({
    baseUrl,
    headers: { authorization: `Bearer ${token}` },
    ...(fetch ? { fetch } : {}),
  });
}

export type { AdminPaths, StorePaths };
export type { components as AdminSchemas } from './generated/admin.js';
export type { components as StoreSchemas } from './generated/store.js';
