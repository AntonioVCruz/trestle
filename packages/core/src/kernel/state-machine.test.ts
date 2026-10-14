import { describe, expect, it } from 'vitest';
import { checkoutStateMachine } from '../modules/checkout/index.js';
import { defineStateMachine, InvalidTransitionError } from './state-machine.js';

describe('defineStateMachine', () => {
  it('rejects transitions to undefined states', () => {
    expect(() =>
      defineStateMachine({
        name: 'broken',
        initial: 'a',
        transitions: { a: ['b'] } as never,
      }),
    ).toThrow(/undefined state/);
  });

  it('rejects an undefined initial state', () => {
    expect(() =>
      defineStateMachine({ name: 'broken', initial: 'missing' as never, transitions: { a: [] } }),
    ).toThrow(/initial state/);
  });
});

describe('checkout state machine', () => {
  const m = checkoutStateMachine;

  it('starts at cart and ends at placed', () => {
    expect(m.initial).toBe('cart');
    expect(m.isFinal('placed')).toBe(true);
    expect(m.isFinal('completing')).toBe(false);
  });

  it('allows the happy path', () => {
    const path = ['cart', 'addressed', 'shipping_selected', 'payment_selected', 'completing', 'placed'] as const;
    for (let i = 1; i < path.length; i++) expect(m.can(path[i - 1]!, path[i]!)).toBe(true);
  });

  it('allows skipping shipping and revisiting earlier steps', () => {
    expect(m.can('addressed', 'payment_selected')).toBe(true);
    expect(m.can('payment_selected', 'addressed')).toBe(true);
  });

  it('compensates a failed completion back to payment selection', () => {
    expect(m.can('completing', 'payment_selected')).toBe(true);
  });

  it('forbids skipping straight to completion or leaving placed', () => {
    expect(() => m.assert('cart', 'completing')).toThrow(InvalidTransitionError);
    expect(m.next('placed')).toEqual([]);
  });
});
