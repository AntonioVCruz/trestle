import { describe, expect, it } from 'vitest';
import { placeWithRetries, type CompletionAttempt } from './completion.js';
import type { Order } from './types.js';

const order = { id: 'ord_1', number: 1001 } as Order;

/** Answers in turn, on a fake clock that sleeping advances. */
function scripted(answers: CompletionAttempt[]) {
  let clock = 0;
  const calls: number[] = [];
  return {
    calls,
    attempt: async () => {
      calls.push(clock);
      return answers.shift()!;
    },
    options: { deadlineMs: 5000, now: () => clock, sleep: async (ms: number) => void (clock += ms) },
  };
}

const inProgress: CompletionAttempt = { status: 409, code: 'completion_in_progress', details: {} };

describe('placeWithRetries', () => {
  it('returns the order', async () => {
    const s = scripted([{ status: 201, order }]);
    expect(await placeWithRetries(s.attempt, s.options)).toEqual({ kind: 'placed', order });
  });

  it('retries network errors, 5xx and a completion in progress, backing off', async () => {
    const s = scripted([{ status: 0, code: null, details: {} }, { status: 502, code: 'payment_provider_failed', details: {} }, inProgress, { status: 200, order }]);
    expect(await placeWithRetries(s.attempt, s.options)).toEqual({ kind: 'placed', order });
    expect(s.calls).toEqual([0, 500, 1500, 3500]);
  });

  it('stops on any other answer and passes it on', async () => {
    const s = scripted([{ status: 402, code: 'payment_declined', details: {} }]);
    expect(await placeWithRetries(s.attempt, s.options)).toEqual({ kind: 'failed', code: 'payment_declined', details: {} });
    expect(s.calls).toHaveLength(1);
  });

  it('reports pending when the order is still being placed at the deadline', async () => {
    const s = scripted(Array.from({ length: 20 }, () => inProgress));
    expect(await placeWithRetries(s.attempt, s.options)).toEqual({ kind: 'pending' });
    expect(s.calls.at(-1)).toBeLessThanOrEqual(5000);
  });
});
