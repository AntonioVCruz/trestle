# 0016. Checkout steps on the cart, and shipping options

- Status: Proposed
- Date: 2026-10-05

## Context

ADR 0005 declares the checkout state machine
(`cart → addressed → shipping_selected → payment_selected → completing → placed`), and ADR 0002
lists `cart`, `checkout` and `fulfillment` as separate modules. Building the first steps raised
these questions:

- Where does the data each step collects live?
- Where do shipping prices come from?
- How does a shipping price reach the totals?

Shipping changes the cart's total, and changing a line or the address can invalidate the chosen
shipping method. So line changes and checkout steps must be consistent with each other.

## Decision

- **Checkout data lives on the cart**: checkout state, email, shipping and billing addresses
  (JSON), and the chosen shipping option with its name and price. Every command takes the same
  row lock and runs the same re-pricing (ADR 0015). That would need a cross-module transaction,
  which ADR 0002 forbids, if checkout kept its own tables.
- **The checkout module** keeps the state machine, which the cart consults for every step. It
  will own the completion saga, which coordinates the cart, inventory, payments and orders
  through their services (ADR 0005).
- **Steps are commands** (ADR 0003): `POST /carts/{id}/addresses`,
  `GET /carts/{id}/shipping-options` and `POST /carts/{id}/shipping-method`.
  - The address step needs at least one available line.
  - Changing the shipping address drops the chosen shipping method and goes back to
    `addressed`. Changing only the email or billing address keeps the cart's step.
  - Once completion starts (`completing`, `placed`), every command is refused with
    `cart_locked`.
- **A `shipping` module** (ADR 0002's `fulfillment` is reserved for after an order exists)
  holds shipping options per channel: a name, a flat price per currency, an optional list of
  countries (null means everywhere), and an active flag. The cart asks it for quotes through
  a `CartShipping` interface it declares itself (ADR 0015).
- **The chosen shipping option is re-quoted on every cart change**, like line prices. If it
  stops being available (deactivated, no longer ships to the address, no price in the
  currency), it is dropped and the cart goes back to `addressed`. A newly chosen option that
  cannot be quoted is refused.
- **Shipping is the first real totals adjuster** (ADR 0006): an order-level `shipping`
  adjustment with priority 200, after promotions and before tax.
- **Every cart requires shipping for now.** The machine allows `addressed → payment_selected`
  for carts that need none, but the catalog has no "requires shipping" flag yet.

## Consequences

- A cart's lines, checkout data and totals change in one transaction, so they cannot disagree.
- The cart row grows with each step. If checkout data outgrows it, a cart-owned table is an
  internal change.
- Not covered yet:
  - the payment step and completion (the payments module, ADR 0008's provider contract, and
    the saga)
  - weight- or price-based shipping rates, carrier integrations and shipping zones beyond
    country lists
  - shipping-free carts
  - address validation beyond required fields and country codes
