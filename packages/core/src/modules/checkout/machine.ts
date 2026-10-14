import { defineStateMachine } from '../../kernel/state-machine.js';

/**
 * Checkout states (ADR 0005). Steps can be revisited (changing the address after choosing
 * shipping drops back to `addressed`). `completing` is held while the completion saga runs and
 * either reaches `placed` or compensates back to `payment_selected`.
 * Carts that need no shipping go straight from `addressed` to `payment_selected`.
 */
export const checkoutStateMachine = defineStateMachine({
  name: 'checkout',
  initial: 'cart',
  transitions: {
    cart: ['addressed'],
    addressed: ['addressed', 'shipping_selected', 'payment_selected'],
    shipping_selected: ['addressed', 'shipping_selected', 'payment_selected'],
    payment_selected: ['addressed', 'shipping_selected', 'payment_selected', 'completing'],
    completing: ['placed', 'payment_selected'],
    placed: [],
  },
});

export type CheckoutState = (typeof checkoutStateMachine.states)[number];
