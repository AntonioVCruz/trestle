# 0014. Pricing model and price resolution

- Status: Proposed
- Date: 2026-10-05

## Context

ADR 0007 proposes price sets with rule-based prices, price lists with validity windows, and
price history. Building the first slice raised these questions:

- Which price wins when several apply?
- How do prices reach the Store API without breaking ADR 0002's module boundaries?
- What do we defer?

The benchmarks answer differently. Medusa's price sets carry rules and price lists with types
(sale or override). Sylius prices per channel and keeps a channel-pricing log for the
lowest-price rule. nopCommerce mixes tier prices and discounts on the product. Vendure prices a
variant per channel and currency.

## Decision

- **Price set per variant.** The pricing module owns `price_set(variant_id)` and its prices. The
  variant id is a plain reference to the catalog (no foreign key). The catalog knows nothing
  about prices.
- **A price** is an integer amount in minor units in one currency (ADR 0006). It has an optional
  channel scope and a minimum quantity (tier pricing). It is either a base price or belongs to a
  price list. Each scope (currency, channel, quantity, list) holds at most one price per
  variant.
- **Price lists** have a name, a type, a `draft`/`active` status, an integer priority, and an
  optional `[startsAt, endsAt)` window. A list's prices apply only while it is active and inside
  its window. This is decided at read time, so a scheduled sale needs no job to switch it on.
- **Two list types:**
  - A **sale** list applies only when it is cheaper than the regular price at that quantity, so
    a sale can never raise a price or undo a bulk tier.
  - An **override** list replaces the regular price, cheaper or not, for contract, B2B or
    surcharge pricing.

  Without the distinction, one "list beats base" rule made a one-unit sale at 18.00 beat a
  15.00 tier for ten units, so buying in bulk cost more during the sale.
- **Resolution** is one pure function (`modules/pricing/rules.ts`). For a currency, channel,
  quantity and moment it works through these steps in order:
  1. Keep only eligible prices: the right currency, for this channel or every channel, minimum
     quantity reached, and a live list if the price belongs to one.
  2. The **regular price** is the best live override price, or the best base price if no
     override applies.
  3. The best live sale price that is cheaper than the regular price applies, and the regular
     price is returned as `original` for "was" displays. With no regular price at all, the best
     sale price applies with no original.

  "Best" means: higher list priority, then channel-specific over every-channel, then the highest
  quantity tier reached, then the lower amount, then the lower id.
- **Store API prices come from composition at the API layer.** The Store API asks the catalog
  for a page of products, then asks pricing to resolve every variant on the page in one query.
  No module reads another's tables, and a page costs one extra query.
- **Validation across modules happens at the API layer.** The Admin API checks variant ids
  through the catalog service, and channel ids and their currencies through the channel service,
  before calling pricing (ADR 0002).
- **Events:** `variant_prices.updated`, `price_list.created` and `price_list.updated` (the last
  also covers a list's prices).

## Deferred

- **Customer-group prices**: a rule column once a customers module exists.
- **Price history and the EU "lowest price in the last 30 days" rule.** Resolution happens at
  read time and depends on list windows, so the history has to record *resolved* prices over
  time, per variant, channel and currency. That needs its own design.
- **Tax-inclusive or tax-exclusive amounts.** Amounts are stored as entered. Whether a channel's
  prices include tax belongs to the tax module and its ADR.
- **Sorting and filtering listings by price.** Composition cannot sort a catalog page by price.
  That, and stock-aware listings, is what the listing read model in ADR 0002 and ADR 0013 is
  for. Because list windows open and close by time, a precomputed price in that model will need
  a refresh at window boundaries.

## Consequences

- Sales, contract prices, channel prices, tier prices and scheduled campaigns work today without
  schema changes.
- Lists created before types existed became sales, which matches how they were used.
- Every price shown in the Store API comes from one tested function, which cart totals will use
  too.
- Listings cannot yet be sorted or filtered by price.
