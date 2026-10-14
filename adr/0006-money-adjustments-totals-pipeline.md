# 0006. Integer money, typed adjustments, ordered totals pipeline

- Status: Accepted
- Date: 2026-10-02

## Context

All benchmarks run an ordered pipeline from subtotal to total:

- OpenCart sorts `total_*` extensions by `sort_order`.
- Shopware runs prioritized collectors and then processors.
- Sylius chains priority-ordered order processors that write typed adjustments.
- Vendure's `OrderCalculator` has a fixed order and prorates order-level discounts.

What goes wrong in them:

- Mutation in place (OpenCart's `&$total`) hides where a cent came from.
- Recomputing everything on every step costs performance in Sylius and Saleor.
- Vendure's fixed order cannot be extended.

## Decision

- Money is `{ amount, currency }` with `amount` a safe integer in minor units. There is no float
  arithmetic. `allocate()` splits amounts by largest remainder, so proration never loses a cent.
- Totals come from `computeTotals(input, adjusters)`. Adjusters are pure functions with an id and
  a priority (higher runs first, ties broken by id). Each adjuster sees the lines plus every
  adjustment produced so far, and returns new adjustments.
- Adjustments are typed (`kind`, `label`, signed `amount`, `target` order or line, `source`).
  `neutral` adjustments, such as VAT already included in prices, are reported but not added.
- The pipeline rejects currency mismatches, unknown line targets and negative totals.
- Promotions, shipping, tax and fees are all adjusters, so extensions plug in the same way core
  does (ADR 0008).
- Totals are recomputed when a cart input changes, not on every read.

## Consequences

- Every amount in an order can be traced to the adjuster that produced it.
- Tax-inclusive and tax-exclusive pricing are both modelled without special cases.
- Adjusters must be deterministic. Anything that needs I/O, such as an external tax provider,
  fetches its data before the pipeline runs.
