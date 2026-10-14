# 0015. Cart model, and how a module depends on another

- Status: Proposed
- Date: 2026-10-05

## Context

The cart is the first module that needs other modules. It needs the catalog (is this variant for
sale in this channel, and what should a line show) and pricing (what does it cost at this
quantity). ADR 0002 lets a module use another module's service, but says nothing on how it gets
one. ADR 0006 says totals are recomputed when cart input changes, not on every read.

Medusa snapshots titles and prices onto line items. Saleor recalculates checkout prices lazily
and marks them stale. Sylius re-runs its order processors on every cart change.

## Decision

- **Dependencies are declared by the dependent module, in its own types.** The cart defines
  `CartCatalog` and `CartPricing`, the narrow questions it needs answered. The composition root
  adapts the catalog and pricing services to them (`packages/core/src/adapters.ts`). The cart
  imports neither module. `defineModule` takes an optional `Deps` type for this.
- **A cart** belongs to one channel and one currency, chosen at creation from the channel's
  currencies.
- **A line** holds one variant, at most once per cart. Adding the same variant raises the
  quantity. Quantities run from 1 to 1000, with at most 100 lines.
- **Every change re-prices every line, under a row lock on the cart.** Lines are priced at their
  own quantity, so tiers apply. Each line stores a copy of its unit price, the "was" price, and
  the product and variant titles, handle and SKU. Totals come from the adjuster pipeline and are
  stored with the cart, so reads do no computation.
- **A line whose variant stops being sellable or priced is kept, not dropped.** It is marked
  unavailable and left out of the totals, so the shopper sees what happened. It becomes
  available again on the next change if the variant returns. A new line must be available.
- **The cart id is the shopper's key**, so the Store API needs no customer session. It has
  80 bits of randomness. A cart exists only in its own channel; from any other publishable key it
  is a 404.
- **Events:** `cart.created` and `cart.updated`.

## Consequences

- Reads are cheap and totals are traceable to their adjusters.
- Stored prices can go stale between changes: a sale that ends leaves its price in a cart nobody
  touches. The checkout completion saga re-validates prices and stock before placing an order
  (ADR 0005). Until then, a stale cart only misleads the display.
- Not covered yet:
  - addresses, shipping and payment steps (the checkout module)
  - promotions, shipping and tax adjusters
  - customer accounts and merging carts
  - expiring abandoned carts
