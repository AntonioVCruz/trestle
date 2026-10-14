import { defineStateMachine } from '../../kernel/state-machine.js';

/**
 * Order states (ADR 0005, ADR 0018). Payment and fulfillment get machines of their own, kept in
 * step by events; this one only says where the order stands as a whole. Only `placed` is reached
 * today; fulfillment and cancellation arrive with their modules.
 */
export const orderStateMachine = defineStateMachine({
  name: 'order',
  initial: 'placed',
  transitions: {
    placed: ['completed', 'canceled'],
    completed: [],
    canceled: [],
  },
});

export type OrderStatus = (typeof orderStateMachine.states)[number];
