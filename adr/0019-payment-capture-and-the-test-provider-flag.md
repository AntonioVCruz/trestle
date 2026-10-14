# 0019. Payment capture, and keeping the test provider out of production

- Status: Proposed
- Date: 2026-10-06
- Refines: ADR 0017 (provider contract, test provider), ADR 0018 (completion saga, ledger)

## Context

ADR 0018 authorizes the payment when an order is placed and leaves capture open: "at
fulfillment or immediately, as a per-provider setting". ADR 0017 registers the built-in `test`
provider in every deployment, so a merchant could enable a provider that moves no money on a
live channel.

What the benchmarks do:

- **Capture.** All eight capture at checkout by default. Authorize-then-capture is opt-in, at
  the narrowest level each one has: per channel (Saleor's `default_transaction_flow_strategy`),
  per payment method (Sylius `use_authorize`, Vendure handler arguments), or per provider
  plugin (Medusa's Stripe `capture`, nopCommerce PayPal `PaymentType`). Deferred capture is
  always manual, from an admin action, an API call or a provider webhook. None captures when an
  order ships; Vendure does the reverse and refuses to ship before the payment is settled.
  Partial capture exists only in Medusa and Saleor. None handles authorizations that lapse
  (cards: typically 7 days); only Saleor releases funds held for abandoned checkouts.
- **Test providers.** None warns or refuses when a test provider is active in production.
  Shopware loads its test handler only in the `test` kernel environment. Saleor deleted its
  dummy plugins. Vendure keeps its dummy handler out of the default config, but its project
  template adds it unconditionally. Medusa always registers its no-op provider. Offline methods
  (cash on delivery, bank transfer) are production features everywhere, not test tools.

We have no fulfillment module yet, so "capture at fulfillment" as a default would leave every
payment uncaptured until its authorization lapsed.

## Decision

### Capture

- **A capture mode per channel and provider**, stored where the merchant enables a provider for
  a channel: `immediate` (the default) or `manual`. The Admin API's
  `PUT /payment-providers/{id}/channels` takes `channels: [{ channelId, captureMode }]`.
  A payment session records the mode when it is created, so changing the setting does not
  affect a checkout already under way.
- **Providers declare `supportsDeferredCapture`.** Only providers that declare it can be set to
  `manual`. Contract version 1.1.0 adds this and the optional fields below; both are additive,
  so 1.0 providers still register.
- **Immediate capture is a saga step after the order exists:** begin, authorize, place, finish,
  then capture. Authorizing stays a separate step, so the compensation for a failed placement is
  still "cancel the authorization", never a refund. A capture that fails does not undo the
  order: the payment stays authorized and `payment.capture_failed` is recorded.
- **A scheduled sweep retries immediate captures** that did not happen, after a crash or a
  provider outage. It only captures a session whose order exists, and gives up after 5 provider
  errors. A declined capture is not retried: someone must look.
- **Manual capture in the Admin API:** `POST /orders/{id}/payment/capture`, with an optional
  amount (the uncaptured remainder by default) and a required `Idempotency-Key`. Admins can
  capture any authorized payment, including an immediate one whose capture failed.
  `GET /orders/{id}/payment` shows the payment and its ledger.
- **Partial capture is allowed.** A session tracks its captured amount and becomes
  `partially_captured`, then `captured`. A provider that cannot capture again after a partial
  capture answers `failed`; the ledger stays truthful either way. Releasing the remainder of a
  partially captured authorization comes later.
- **One capture at a time per session.** A capture claims the session before calling the
  provider (no lock is held during the call), and a second one gets
  `payment_capture_in_progress`. A claim older than 5 minutes is considered abandoned.
- **Authorization expiry.** An authorize result may carry `expiresAt`. A scheduled task records
  `payment.authorization_expiring` once for each authorized session with an uncaptured amount
  that lapses within 48 hours, so order emails and an admin UI can act on it later.
- **Capture at fulfillment** becomes a third mode, `on_fulfillment`, when fulfillment exists.
  Vendure's rule (no shipping until paid) is the alternative to weigh then.

### The test provider

- **Registered only when `ENABLE_TEST_PAYMENT_PROVIDER=true`.** It is off unless set, in every
  process role. `.env.example` and `compose.yaml` turn it on for local use; a staging deployment
  where end-to-end tests run (ADR 0011) turns it on too. We keep it, unlike Saleor, because
  those tests need declines, required actions and capture failures against a real deployment.
- **Providers declare `testMode`.** The test provider does; a gateway can report it when it is
  configured with sandbox credentials. The Admin API shows it, so an admin UI can mark it.
- **Guards the benchmarks lack:** the web role logs a warning at startup when a test-mode
  provider is registered, and when a channel still enables a provider that is no longer
  registered (which is then simply not offered).
- **The test provider gains capture outcomes:** `{ "outcome": "capture_decline" }` authorizes
  and then declines the capture, and authorizations expire after 7 days.

## Consequences

- Payments are captured by default; nothing waits on a fulfillment module that does not exist.
- Merchants who capture by hand (made-to-order goods, fraud review) can, per channel.
- The sweep and the expiry warning add two scheduled tasks; both are bounded and idempotent.
- A deployment that forgets the flag has no test provider: checkout tests against it fail
  loudly instead of production silently accepting fake payments.
- If a stale completion used a provider that is no longer registered, cancelling its
  authorization fails, `checkout.compensation_failed` is recorded, and the cart is still
  released, as for any failing compensation.
- Breaking for Admin API clients: the provider resource now has `channels` instead of
  `channelIds`. Nothing has been released, so there is no deprecation period.
