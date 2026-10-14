# 0004. Channels, selected by publishable key

- Status: Accepted
- Date: 2026-10-02

## Context

Every benchmark has multi-store built in, but the older ones bolt it on: OpenCart's ~106
`store_id` references and nopCommerce's `StoreMapping`. The newer ones converge on a "channel":

- Saleor: a channel per currency, with per-channel product listings.
- Sylius: currencies, locales, a tax zone and pricing per channel.
- Medusa: sales channels scoped by publishable API keys.
- Shopware: sales channels selected by `sw-access-key`.
- Vendure: channels selected by the `vendure-token` header.

## Decision

- A channel is one storefront: its currencies, locales and, as modules land, its catalog
  visibility, price lists, stock locations and tax zone.
- Every Store API request names its channel with an `x-publishable-key` header. Keys are not
  secret (they ship in browser code); they only select a channel. Keys can be revoked and are
  issued through the Admin API.
- Domain-based routing, if needed, maps a host to a key at the edge, not in core.

## Consequences

- One installation serves many storefronts without a separate database per tenant.
- Anything that varies by storefront must take a channel id. Module APIs make that explicit
  rather than reading it from ambient request state.
