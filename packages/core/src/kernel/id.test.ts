import { describe, expect, it } from 'vitest';
import { isId, newId } from './id.js';

describe('ids', () => {
  it('recognizes ids it made, with their prefix', () => {
    const id = newId('prod');
    expect(id).toMatch(/^prod_[0-9a-f]{32}$/);
    expect(isId(id, 'prod')).toBe(true);
    expect(isId(id, 'ord')).toBe(false);
  });

  it('rejects anything else', () => {
    for (const value of ['x', '', 'prod_', 'prod_9', `prod_${'g'.repeat(32)}`, `prod_${'a'.repeat(33)}`, `PROD_${'a'.repeat(32)}`]) {
      expect(isId(value, 'prod')).toBe(false);
    }
  });
});
