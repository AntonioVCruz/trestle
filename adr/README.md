# Architecture decision records

Each significant decision gets a short, numbered record: the context, the decision, and its
consequences. Records are immutable once accepted; a later record supersedes an earlier one
instead of rewriting it. Copy `0000-template.md` to propose a new one.

| # | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-modular-monolith.md) | Modular monolith with module-owned data | Accepted |
| [0003](0003-api-first-store-and-admin-apis.md) | API-first: separate Store and Admin REST APIs with OpenAPI | Accepted |
| [0004](0004-channels-and-publishable-keys.md) | Channels, selected by publishable key | Accepted |
| [0005](0005-checkout-state-machine-and-completion-saga.md) | Checkout as an explicit state machine; completion as a saga | Accepted |
| [0006](0006-money-adjustments-totals-pipeline.md) | Integer money, typed adjustments, ordered totals pipeline | Accepted |
| [0007](0007-pricing-inventory-payments-model.md) | Pricing, inventory and payments domain model | Proposed |
| [0008](0008-extension-contract.md) | One extension contract, two runtimes | Proposed |
| [0009](0009-process-roles-outbox-postgres.md) | Process roles, transactional outbox, Postgres-only | Accepted |
| [0010](0010-typescript-stack.md) | TypeScript stack and tooling | Accepted |
| [0011](0011-testing-strategy.md) | Testing strategy | Accepted |
| [0012](0012-license-and-clean-room.md) | MIT license and clean-room policy | Proposed |
| [0013](0013-catalog-model-and-store-reads.md) | Catalog model, channel visibility and Store API reads | Proposed |
| [0014](0014-pricing-model-and-resolution.md) | Pricing model and price resolution | Proposed |
| [0015](0015-cart-model-and-module-dependencies.md) | Cart model, and how a module depends on another | Proposed |
| [0016](0016-checkout-steps-on-the-cart-and-shipping-options.md) | Checkout steps on the cart, and shipping options | Proposed |
| [0017](0017-payment-provider-contract-and-payment-step.md) | Payment provider contract (v1) and the payment step | Proposed |
| [0018](0018-order-placement-saga-and-orders.md) | Placing an order: the completion saga, orders and the payment ledger | Proposed |
| [0019](0019-payment-capture-and-the-test-provider-flag.md) | Payment capture, and keeping the test provider out of production | Proposed |
| [0020](0020-reference-storefront-astro.md) | The reference storefront: Astro, rendered on the server | Proposed |

The benchmark study behind these decisions is in [`docs/benchmarks.md`](../docs/benchmarks.md).
