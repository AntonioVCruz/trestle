# 0007. Pricing, inventory and payments domain model

- Status: Proposed. To be accepted with the first implementation of each module.
- Date: 2026-10-02

## Context

- OpenCart bolts variants on through `master_id`. nopCommerce models SKU-level stock with
  attribute combinations.
- Medusa uses price sets with rule-based prices and price lists. Sylius prices per channel and
  keeps price history.
- Saleor separates time-limited checkout reservations from order allocations. Medusa and Vendure
  track stock per location.
- ERPNext keeps a stock ledger plus a cached balance (`bin`).
- Saleor records payments as a ledger of transaction events that apps report.

## Decision (proposed)

- **Catalog:** Product → Variant (the sellable SKU) → options. Every product has at least one
  variant.
- **Pricing:** a variant links to a price set. Prices carry rules (channel, currency, customer
  group, minimum quantity) and a priority. Price lists group prices with validity windows. Price
  history is kept for compliance, such as the EU lowest-price-in-30-days rule.
- **Inventory:** inventory items, with stock levels per location. Time-limited **reservations**
  during checkout are separate from **allocations** on orders. Every change appends to a stock
  movement ledger, and balances are derived.
- **Payments:** a payment transaction per order, with an append-only event ledger (authorize,
  charge, refund, cancel, each with an amount). Order payment status is aggregated from the
  ledger. Providers report events; core never contains gateway-specific code.

## Consequences

Partial captures, split payments, multi-warehouse fulfillment and price-rule promotions all fit
without schema changes. The cost is more rows and more aggregation than a single `status`
column.
