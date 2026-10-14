/**
 * The payment provider contract, version 1 (ADR 0008, ADR 0017). Core never contains
 * gateway-specific code (ADR 0007): a gateway is a provider implementing this interface.
 *
 * Requests and results are plain JSON-compatible data, so the same contract can later be served
 * by an out-of-process app over signed HTTP. Expected outcomes (a declined card) are results;
 * a thrown error means the provider itself failed (network, bug) and is treated as such.
 */
export const PAYMENT_PROVIDER_CONTRACT_VERSION = '1.1.0';

/** Minor units and an ISO 4217 code, as in core's Money. */
export interface ProviderAmount {
  readonly amount: number;
  readonly currency: string;
}

/** Opaque JSON a storefront exchanges with a provider (tokens, client secrets, test outcomes). */
export type ProviderData = Readonly<Record<string, unknown>>;

export interface InitiateRequest {
  /** Core's payment session id; stable across retries. */
  readonly sessionId: string;
  readonly amount: ProviderAmount;
  readonly email: string | null;
  /** What the storefront sent when choosing this method. */
  readonly data: ProviderData;
  /** Same key, same effect: providers must make retries safe. */
  readonly idempotencyKey: string;
}

export interface InitiateResult {
  /** The provider's own id for the payment, if it has one yet. */
  readonly reference: string | null;
  /** Handed to the storefront, e.g. a client secret for a payment form. */
  readonly clientData: ProviderData;
}

export interface PaymentOperationRequest {
  readonly sessionId: string;
  readonly reference: string | null;
  readonly amount: ProviderAmount;
  readonly data: ProviderData;
  readonly idempotencyKey: string;
}

export type ProviderOutcome =
  | {
      readonly status: 'succeeded';
      readonly reference: string;
      /** For authorizations: when the reservation lapses (ISO 8601), if the provider knows. Since 1.1. */
      readonly expiresAt?: string;
    }
  | { readonly status: 'failed'; readonly reason: string }
  /** The shopper must do something first, e.g. 3-D Secure; `clientData` says what. */
  | { readonly status: 'requires_action'; readonly clientData: ProviderData };

export interface PaymentProvider {
  /** Stable and unique, e.g. `stripe`; stored on sessions. */
  readonly id: string;
  /** Shown to shoppers and merchants. */
  readonly name: string;
  /** The contract version the provider was written against; the major version must match. */
  readonly contractVersion: string;
  /**
   * Can capture some time after authorizing, so merchants may capture by hand (ADR 0019).
   * Without it, channels can only capture immediately. Since 1.1.
   */
  readonly supportsDeferredCapture?: boolean;
  /** Moves no real money (a test provider, or a gateway on sandbox credentials). Since 1.1. */
  readonly testMode?: boolean;
  /** Called when a shopper chooses this method; prepares the payment. */
  initiate(request: InitiateRequest): Promise<InitiateResult>;
  /** Reserves the amount; called when the order is placed. */
  authorize(request: PaymentOperationRequest): Promise<ProviderOutcome>;
  /**
   * Takes `amount` of an authorization, which may be less than authorized (a partial capture).
   * A provider that cannot capture again after a partial capture answers `failed`.
   */
  capture(request: PaymentOperationRequest): Promise<ProviderOutcome>;
  /** Releases an authorization, e.g. when placing the order fails afterwards. */
  cancel(request: PaymentOperationRequest): Promise<ProviderOutcome>;
  refund(request: PaymentOperationRequest): Promise<ProviderOutcome>;
}

const PROVIDER_ID = /^[a-z][a-z0-9_-]{1,39}$/;

/** Checks a provider can be registered: a valid id and a compatible contract version. */
export function checkProvider(provider: PaymentProvider): void {
  if (!PROVIDER_ID.test(provider.id)) throw new Error(`Invalid payment provider id "${provider.id}"`);
  const major = (version: string) => version.split('.')[0];
  if (major(provider.contractVersion) !== major(PAYMENT_PROVIDER_CONTRACT_VERSION)) {
    throw new Error(
      `Payment provider "${provider.id}" targets contract ${provider.contractVersion}; core implements ${PAYMENT_PROVIDER_CONTRACT_VERSION}`,
    );
  }
}
