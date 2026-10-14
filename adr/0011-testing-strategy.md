# 0011. Testing strategy

- Status: Accepted
- Date: 2026-10-02

## Context

- OpenCart has no unit tests.
- nopCommerce and OpenCart both run plain-English testRigor end-to-end suites.
- Vendure boots a real server per e2e suite.
- Sylius runs 855 Behat scenarios against both its UI and its API.
- Saleor asserts query counts.
- Shopware layers unit, integration, migration, performance and Playwright acceptance tests.

## Decision

1. **Unit tests** for pure domain logic: money, totals and adjusters, state machines, rules.
2. **Architecture tests** that enforce ADR 0002 (`packages/core/src/architecture.test.ts`).
3. **API tests** with `fastify.inject` against fake services: auth, error shapes, spec contents.
4. **Integration tests** against a real Postgres for services, migrations and the outbox, with
   query-count assertions on hot paths. These start with the first module that has non-trivial
   queries.
5. **Contract tests:** the committed OpenAPI documents must match the running server, and the
   SDK must compile against them.
6. **End-to-end scenarios** in plain English (testRigor) against the reference storefront and
   admin, covering the flows a merchant cares about: browse, cart, checkout, order management.

## Consequences

Domain logic stays pure so it is cheap to test. Every bug fix comes with a test at the lowest
layer that reproduces it.
