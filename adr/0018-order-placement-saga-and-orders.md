# 0018. Placing an order: the completion saga, orders and the payment ledger

- Status: Proposed
- Date: 2026-10-05
- Refines: ADR 0005 (completion saga), ADR 0007 (payments)

## Context

ADR 0005 decides that completion is a saga with an idempotency key: lock the cart, re-validate
prices and stock, reserve inventory, authorize payment and create the order, each step
compensable. It also decides that a second concurrent attempt gets a 409, and that a retry
returns the existing order. ADR 0007 asks for an append-only payment ledger.

This is the first code that spends money, and it must survive failures between steps. That
includes a process that dies halfway. nopCommerce's 3.5k-line order service and Saleor's 2k-line
completion module show what happens when this logic grows without structure. Medusa's completion
workflow, with a lock and compensations, is the model we follow.

## Decision

- **The checkout module owns the saga** (`modules/checkout/completion.ts`). It talks to the
  cart, payments and orders through interfaces it declares itself (ADR 0015), wired in
  `adapters.ts`. Its steps and their compensations:

  | Step | Does | Compensation |
  |---|---|---|
  | 1. begin (cart) | Lock the cart, re-price lines and shipping. If the total still equals the payment amount and every line is available, freeze the cart as `completing` with the completion key | Release the cart |
  | 2. authorize (payments) | Reserve the amount with the provider | Cancel the authorization |
  | 3. place (orders) | Write the order; idempotent per cart | none (last step that can fail) |
  | 4. finish (cart) | Mark the cart `placed` with the order id | none: retried |

- **Releasing the cart (refines ADR 0005).** The cart goes back to `payment_selected` only if its
  payment session can still be used: the shopper must act, or the provider failed transiently.
  After a decline, or once an authorization was canceled, it goes back to `shipping_selected`,
  and the shopper chooses a payment method again.
- **Re-validation saves what it finds.** If prices or shipping changed since the payment was
  prepared, the re-priced cart is stored without its payment and completion answers
  `cart_changed`. An order is never placed at a price the shopper did not see.
- **Idempotency:**
  - `POST /carts/{id}/complete` requires an `Idempotency-Key` header.
  - A concurrent attempt gets `409 completion_in_progress`.
  - Once placed, any further attempt returns the same order with 200. The first success
    returns 201.
  - The provider's authorization key is per payment session (`{sessionId}:authorize`), so no
    retry, with any completion key, can authorize the same payment twice.
  - `sales_order.cart_id` is unique, so one cart yields at most one order, even under
    concurrent writers.
  - So the cart, not the key, is the unit of idempotency. The key is recorded on the cart while
    an attempt runs, but no response is replayed by key. A retry with a different key is just as
    safe as one with the same key.
- **How clients retry.** A storefront generates one key per "place order" action and reuses it
  for automatic retries of that action. That is the conventional contract, and it leaves room to
  check keys later.
  - Retry on network errors, 5xx and `409 completion_in_progress`, with backoff. Stop on any
    other error. While the first attempt runs, a retry cannot return the order (it does not
    exist yet), so it gets the 409.
  - Alternatively, poll `GET /carts/{id}`, which has no side effects. When `checkoutState` is
    `placed`, `orderId` names the order.
  - If an attempt was abandoned mid-way, recovery resolves the cart within about five minutes.
    After that, `complete` either returns the order or answers `409 payment_required` (the cart
    was released). A client should stop waiting after a short time and tell the shopper the order
    is being confirmed.
- **Recovery.** If the process dies between steps, the cart stays `completing` (with
  `completion_started_at` set). The next request for it, or the scheduler's
  `checkout.recover-stale` task (every minute, for completions older than five minutes), works
  out what happened. If the order exists, the cart is marked placed. Otherwise the authorization
  is canceled and the cart released. A compensation that fails records
  `checkout.compensation_failed`, and a cancellation that fails records `payment.cancel_failed`,
  so money left reserved is visible to operators.
- **Orders** (`orders` module, table `sales_order`) are a full copy of the cart at placement:
  lines, addresses, shipping method, adjustments (re-targeted to order line ids), totals and the
  payment session. They have a sequential `number` starting at 1001. The order state machine
  starts at `placed`; fulfillment and cancellation will move it.
- **The payment ledger** (`payment_transaction`) records every authorize, capture, cancel and
  refund call with its outcome (`succeeded`, `failed`, `requires_action`, `error`). A session's
  status follows: `pending → authorized | requires_action | failed`, then
  `authorized → canceled`.
- **HTTP statuses for completion:**
  - 402: the payment was declined
  - 409: the cart is not ready, changed, is already being completed, or the shopper must act
    (`error.details.clientData` says how)
  - 502: the payment provider failed

## Consequences

- The first purchase works end to end through public APIs, and every failure path has a test:
  decline, required action, provider outage, price change, concurrent attempts, a crash after
  authorizing, a failing compensation.
- Orders do not change when the catalog, prices or shipping change later.
- Not covered yet:
  - Inventory reservation, a saga step between begin and authorize when inventory exists.
  - Capturing payment, at fulfillment or immediately, as a per-provider setting. Decided in
    ADR 0019: a capture mode per channel and provider, immediate by default.
  - Order confirmation emails, through outbox subscribers once per-subscriber delivery
    tracking exists.
  - Customer accounts linking orders.
  - Cancellation and refunds as order transitions.
