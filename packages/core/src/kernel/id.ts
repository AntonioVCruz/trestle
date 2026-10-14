import { randomBytes } from 'node:crypto';

/**
 * Prefixed, time-ordered ids: `chn_0199a3f2c1d4e5f6a7b8c9d0e1f2a3b4`.
 * The prefix makes ids self-describing in logs and APIs; the leading millisecond timestamp
 * keeps b-tree inserts roughly sequential.
 */
export function newId(prefix: string): string {
  if (!/^[a-z]{2,8}$/.test(prefix)) throw new RangeError(`Invalid id prefix "${prefix}"`);
  const time = Date.now().toString(16).padStart(12, '0');
  return `${prefix}_${time}${randomBytes(10).toString('hex')}`;
}

/** Whether a value has the shape `newId(prefix)` produces. It says nothing about existence. */
export function isId(value: string, prefix: string): boolean {
  return value.length === prefix.length + 33 && value.startsWith(`${prefix}_`) && /^[0-9a-f]{32}$/.test(value.slice(prefix.length + 1));
}
