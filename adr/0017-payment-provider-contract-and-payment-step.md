# 0017. Payment provider contract (v1) and the payment step

- Status: Proposed
- Date: 2026-10-05

## Context

ADR 0008 says the extension contract is designed with its first provider type, payments. ADR
0007 says core never contains gateway-specific code and that payments become a ledger of
transaction events. ADR 0005 puts authorization inside the completion saga.

Gateways differ in shape. Some need a server-side setup before the shopper sees a payment form,
such as Stripe's PaymentIntent and its client secret. Some need a shopper action, such as
3-D Secure. Some are offline, such as bank transfer or cash on delivery. Medusa models this as
payment sessions on a cart, created through provider modules. Saleor has apps report
transaction events.

## Decision

- **A typed provider contract, version 1.0.0** (`modules/payments/provider.ts`). Its operations
  are `initiate`, `authorize`, `capture`, `cancel` and `refund`.
  - Requests and results are JSON-compatible: amounts are `{ amount, currency }` in minor units,
    and provider data is an opaque JSON object. An out-of-process app can therefore serve the
    same contract later.
  - Every call carries an idempotency key.
  - Expected outcomes are results: `succeeded`, `failed` with a reason, or `requires_action`
    with client data. A thrown error means the provider itself failed.
  - A provider declares the contract version it targets, and the major version must match core's.
- **Providers are registered in code** by the deployment (`createCore({ paymentProviders })`).
  Merchants choose per channel which registered providers are offered. A registered provider is
  offered nowhere until a merchant enables it.
- **A built-in `test` provider** moves no money. The storefront picks the outcome with
  `{ "outcome": "decline" | "requires_action" }`, so checkout failures can be tested end to end.
  The server registers it; it is visible only in channels where it is enabled.
- **Payment sessions.** Choosing a payment method creates a session with the provider for the
  cart total. The provider's reference and client data are stored, and the client data is
  returned to the storefront (for example, a client secret for a payment form). The provider is
  called with no database lock held. If the provider throws, the session is marked `failed` and
  the shopper gets a 502.
- **The payment step** (`POST /carts/{id}/payment-method`) moves the cart from
  `shipping_selected` to `payment_selected`.
  - It reads the cart, prepares the session, then saves only if the cart has not changed in the
    meantime (an optimistic check on `updated_at`). Otherwise it answers `cart_changed`, and
    the step can simply be repeated. An abandoned session is left `pending`.
  - A session is valid for one amount. Any later change to the cart total, or undoing an earlier
    step, drops the payment choice and returns the cart to the shipping step.
- **Deferred:**
  - Authorization, capture, cancel and refund calls, and the append-only transaction ledger,
    arrive with orders and the completion saga, which will use this contract.
  - Provider configuration schemas (ADR 0008) arrive with the first configurable provider
    (Stripe), together with secret storage.

## Consequences

- A gateway is a package implementing one interface. Core does not change to add Stripe.
- Checkout failure paths (decline, required action, provider outage) can be exercised in tests
  and in testRigor scenarios with the test provider.
- Abandoned sessions accumulate as `pending` rows. They are cheap, and a scheduled cleanup can
  come later.
