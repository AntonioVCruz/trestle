import { shouldRetryCompletion } from './checkout.js';
import type { Order } from './types.js';

/** The answer to one POST /carts/{id}/complete. */
export type CompletionAttempt =
  | { readonly status: number; readonly order: Order }
  | { readonly status: number; readonly code: string | null; readonly details: Readonly<Record<string, unknown>> };

export type CompletionResult =
  | { readonly kind: 'placed'; readonly order: Order }
  | { readonly kind: 'failed'; readonly code: string; readonly details: Readonly<Record<string, unknown>> }
  /** Still running when time ran out: show 3e and keep polling the cart. */
  | { readonly kind: 'pending' };

export interface RetryOptions {
  /** Stop retrying after this long and report `pending`. */
  readonly deadlineMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Waits between attempts: 0.5 s, 1 s, then every 2 s, as 3e suggests. */
const backoff = (attempt: number) => Math.min(500 * 2 ** attempt, 2000);

/**
 * Places the order, retrying with the same Idempotency-Key on network errors, 5xx and
 * `completion_in_progress`, and stopping on any other answer (ADR 0018). The storefront server
 * runs this, so the browser only submits a form.
 */
export async function placeWithRetries(attempt: () => Promise<CompletionAttempt>, options: RetryOptions): Promise<CompletionResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.deadlineMs;
  for (let n = 0; ; n++) {
    const answer = await attempt();
    if ('order' in answer) return { kind: 'placed', order: answer.order };
    if (!shouldRetryCompletion(answer.status, answer.code)) {
      return { kind: 'failed', code: answer.code ?? 'unknown', details: answer.details };
    }
    const wait = backoff(n);
    if (now() + wait > deadline) return { kind: 'pending' };
    await sleep(wait);
  }
}
