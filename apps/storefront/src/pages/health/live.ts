import type { APIRoute } from 'astro';

/** Liveness: the process answers. Needs nothing else, so restarts don't hinge on the API. */
export const GET: APIRoute = () => Response.json({ status: 'ok' });
