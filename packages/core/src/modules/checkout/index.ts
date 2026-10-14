import { defineModule } from '../../kernel/module.js';
import { createCheckoutService, type CheckoutDependencies, type CheckoutService } from './completion.js';

/** Owns the checkout state machine and the completion saga; it has no tables of its own. */
export const checkoutModule = defineModule<'checkout', CheckoutService, CheckoutDependencies>({
  name: 'checkout',
  migrations: [],
  createService: createCheckoutService,
});

export { checkoutStateMachine, type CheckoutState } from './machine.js';
export {
  COMPENSATION_FAILED,
  type AuthorizeError as CompletionAuthorizeError,
  type BeginError as CompletionBeginError,
  type CheckoutAddress,
  type CheckoutDependencies,
  type CheckoutService,
  type CompleteCartError,
  type CompletingCart,
  type CompletingLine,
  type CompletionCarts,
  type CompletionOrders,
  type CompletionPayments,
  type CompletionResult,
} from './completion.js';
