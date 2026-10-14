import type { Channel } from './types.js';

/** The cookie that remembers the shopper's currency (wireframe 2b). */
export const CURRENCY_COOKIE = 'currency';

/** The remembered currency if the channel still offers it, else the channel's default. */
export function chooseCurrency(channel: Pick<Channel, 'currencies' | 'defaultCurrency'>, remembered: string | undefined): string {
  return remembered && channel.currencies.includes(remembered) ? remembered : channel.defaultCurrency;
}

/** A same-site path with query parameters set (replacing any of the same name). */
export function withParams(path: string, params: Readonly<Record<string, string>>): string {
  const url = new URL(path, 'http://storefront.invalid');
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.pathname + url.search;
}

/** A same-site path to send the shopper back to after a form post, or the home page. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  return value;
}
