# 0008. One extension contract, two runtimes

- Status: Proposed. The direction is accepted; the contract is designed with the first provider
  type (payments). The in-process payment provider contract is ADR 0017.
- Date: 2026-10-02

## Context

- **In-process and typed, but not isolated:**
  - nopCommerce: typed plugin interfaces, with exact `SupportedVersions` matches.
  - Vendure: 60+ typed strategies, whose typed args also render admin forms.
  - Medusa: providers and modules.
  - Sylius: tagged services and decoration.
- **Out-of-process:** Saleor apps (signed sync webhooks for tax, shipping and payment, payloads
  shaped by subscription queries, a circuit breaker) and Shopware apps (manifest, HMAC, app
  scripts).
- Both Saleor and Shopware run **two extension systems** side by side, and Saleor's sync-webhook
  responses are only loosely validated JSON.
- "Decorate anything" (Shopware, Sylius) makes upgrades fragile. Shopware's 2026 ADR moves to
  typed extension points because of it.

## Decision

- Extension points are explicit and few:
  - **Providers** (typed interfaces): payment, tax, shipping rates, fulfillment, notification,
    search, file storage.
  - **Rules** (typed): promotion conditions and actions, shipping and payment eligibility, price
    rules.
  - **Adjusters:** the totals pipeline (ADR 0006).
  - **State-machine hooks:** transition guards and effects (ADR 0005).
  - **Events:** delivered after commit through the outbox (ADR 0009).
  - **UI slots:** named, prioritized slots in the storefront and admin.
- Each provider declares a typed config schema. The admin renders forms from it and core
  validates it.
- The same contract runs in two runtimes:
  - **in-process:** an npm package, for trusted, latency-critical code;
  - **out-of-process:** an app, declared by a manifest with permissions. Calls are HMAC-signed
    HTTP; responses are validated against the same schema; every call has a timeout and a
    circuit breaker.
- No service decoration and no monkey-patching. If an extension needs a hook that does not
  exist, we add a typed one.
- Contracts are versioned with semver independently of the core release.

## Consequences

- A tax provider written as an app and one written as a package are interchangeable.
- We must design and maintain extension points deliberately. That is slower than "override
  anything", but it is what makes upgrades safe.
