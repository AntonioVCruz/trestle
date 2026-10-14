import type { APIRoute } from 'astro';
import { storeApi } from '../../lib/store-api.js';

/**
 * Readiness: the Store API is reachable and accepts the publishable key, so pages can render.
 * A wrong key or a stopped API answers 503 here instead of a 500 page for shoppers.
 */
export const GET: APIRoute = async () => {
  try {
    const { data, error, response } = await storeApi.GET('/store/v1/channel');
    if (data) return Response.json({ status: 'ok' });
    return Response.json({ status: 'unavailable', reason: error?.error.code ?? `HTTP ${response.status}` }, { status: 503 });
  } catch {
    return Response.json({ status: 'unavailable', reason: 'store_api_unreachable' }, { status: 503 });
  }
};
