import { defineModule } from '../../kernel/module.js';
import { migrations } from './migrations.js';
import { createPaymentsService, type PaymentsDependencies, type PaymentsService } from './service.js';

export const paymentsModule = defineModule<'payments', PaymentsService, PaymentsDependencies>({
  name: 'payments',
  migrations,
  createService: createPaymentsService,
});

export {
  checkProvider,
  PAYMENT_PROVIDER_CONTRACT_VERSION,
  type InitiateRequest,
  type InitiateResult,
  type PaymentOperationRequest,
  type PaymentProvider,
  type ProviderAmount,
  type ProviderData,
  type ProviderOutcome,
} from './provider.js';
export { testPaymentProvider } from './test-provider.js';
export type { CaptureMode, PaymentSessionStatus, PaymentTransactionKind, PaymentTransactionStatus } from './tables.js';
export {
  MAX_AUTOMATIC_CAPTURE_ATTEMPTS,
  MAX_PROVIDER_DATA_BYTES,
  PAYMENT_AUTHORIZATION_EXPIRING,
  PAYMENT_AUTHORIZED,
  PAYMENT_CANCEL_FAILED,
  PAYMENT_CANCELED,
  PAYMENT_CAPTURE_FAILED,
  PAYMENT_CAPTURED,
  PAYMENT_SESSION_CREATED,
  type AuthorizeError,
  type AuthorizeInput,
  type CancelAuthorizationError,
  type CaptureError,
  type CaptureInput,
  type PaymentMethod,
  type PaymentProviderInfo,
  type PaymentSession,
  type PaymentsDependencies,
  type PaymentsService,
  type PaymentTransaction,
  type ProviderChannel,
  type SetProviderChannelInput,
  type SetProviderChannelsError,
  type StartSessionError,
  type StartSessionInput,
} from './service.js';
