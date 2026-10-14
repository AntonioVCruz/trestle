# 0005. Checkout as an explicit state machine; completion as a saga

- Status: Accepted
- Date: 2026-10-02

## Context

- Medusa's `complete-cart` workflow is safe: it takes a lock, has compensating steps and is
  idempotent. But checkout state is implicit (`completed_at`, payment sessions), so it is hard to
  audit.
- Saleor has no checkout state machine and runs two parallel payment flows.
- Sylius and Vendure model checkout, order, payment and fulfillment as explicit state machines,
  and Vendure lets you extend them with typed custom states.
- Shopware stores its state machines as data.

## Decision

- Checkout is a declared state machine (`packages/core/src/modules/checkout`):
  `cart → addressed → shipping_selected → payment_selected → completing → placed`. Earlier steps
  can be revisited, and carts that need no shipping go from `addressed` to `payment_selected`.
- Every transition goes through `machine.assert(from, to)`. Definitions are data, so they can be
  documented, rendered in the admin and extended through the extension contract (ADR 0008).
- The `completing → placed` transition runs a completion saga: lock the cart, re-validate
  prices and stock, reserve inventory, authorize payment, create the order. Each step has a
  compensation. If a step fails the saga compensates back to `payment_selected`. Completion takes
  an idempotency key; a second concurrent attempt gets 409 and a retry returns the existing order.
- Order, payment and fulfillment get their own machines, kept in step by events, not by one
  combined state.

## Consequences

- Every order has an auditable history of transitions.
- Saga steps must be idempotent and individually compensable. That is more design work per
  step, but it is what makes payment failures recoverable.
