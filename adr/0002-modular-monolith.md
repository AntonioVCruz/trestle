# 0002. Modular monolith with module-owned data

- Status: Accepted
- Date: 2026-10-02

## Context

Every benchmark ships one deployable, and that is enough for this domain. Their pain is inside
the monolith: nopCommerce's `OrderProcessingService` (~3.5k lines) and `CheckoutController`
(~2.2k), Saleor's ~2k-line `complete_checkout.py`, Saleor Django apps importing each other freely,
and Sylius's `Core` component gluing its "decoupled" components back together. Medusa is the
counter-example: each module owns its models and migrations, with no foreign keys across modules,
but its link tables and graph query layer add enough query cost that it needed a separate index
module.

## Decision

- One deployable, split internally into modules under `packages/core/src/modules/<name>`
  (catalog, pricing, cart, checkout, orders, payments, inventory, promotions, tax, fulfillment,
  customers, channel, content).
- A module owns its tables, its migrations and one service. Other modules use only that service
  or the events it records, imported through the module's `index.ts`.
- References across modules are plain ids, with no foreign keys and no joins across modules.
  Storefront reads that span modules (e.g. a product listing with price and stock) come from
  read models maintained from events, not from shared tables.
- The shared Kysely handle knows no tables; a module narrows it with
  `db.withTables<ModuleTables>()`, so touching another module's tables is a type error.
- `packages/core/src/core.ts` is the only composition root.
- `architecture.test.ts` enforces the import rules on every test run.

## Consequences

- Modules can be reasoned about, tested and eventually extracted on their own.
- Some reads need a read model where a join would have been quicker to write. That is a
  deliberate cost; we keep read models few and owned by the module that serves the read.
- Consistency across modules goes through the outbox (ADR 0009) or a saga (ADR 0005), never
  through a shared transaction across modules.
