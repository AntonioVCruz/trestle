# Benchmark study (2026-10)

Eight open-source commerce platforms were read, from local clones next to this repo
(`../<name>`), to inform the ADRs. They are used for ideas only; see ADR 0012 for the clean-room
policy.

| Project | Version read | Stack | License |
|---|---|---|---|
| OpenCart | 4.x (`e2e33c86f0`) | PHP 8.1+, Twig, raw SQL | GPLv3 |
| nopCommerce | 5.00 (`399d6704a9`) | .NET 10, Razor, linq2db, FluentMigrator | NPL 4.0 (AGPLv3 + "powered by") |
| ERPNext + frappe_docker | v17-dev (`5fa68dd068`) | Python 3.14, Frappe, MariaDB/Postgres, Redis, RQ | GPLv3 (frappe_docker MIT) |
| Medusa | 2.21.2 (`0186adb4`) | TypeScript, MikroORM, Postgres, Redis | MIT + enterprise (RBAC/SSO) |
| Saleor | 3.24.0-a.0 (`8385ca6`) | Python 3.12, Django 5.2, GraphQL (graphene 2), Celery | BSD-3-Clause |
| Vendure | 3.7.3 (`859619c`) | TypeScript, NestJS, GraphQL, TypeORM | GPLv3 or commercial |
| Sylius | 2.3.1-dev (`2689b33`) | PHP 8.3, Symfony, API Platform, Doctrine | MIT |
| Shopware | 6.7.x (`b84b54f0`) | PHP 8.2, Symfony, custom DAL, Vue admin | MIT |

## Comparison

| | API | Store/Admin split | Extensions | Checkout | Multi-store |
|---|---|---|---|---|---|
| OpenCart | Session API used only by the admin | – | In-process events (before/after, by-ref args) | Ad-hoc AJAX controllers | `store_id` columns |
| nopCommerce | None in core | – | Typed plugin interfaces + ~195 widget zones | One 3.5k-line service | `StoreMapping` |
| ERPNext | REST generated from DocTypes | No | `hooks.py`, apps on top of apps | Webshop split out of core | One database per site |
| Medusa | REST, file-based routes | Yes, publishable key → sales channel | In-process modules, providers, workflow hooks | Compensating workflow with locks | Sales channels |
| Saleor | GraphQL | No; field-level permissions | Out-of-process apps + legacy plugins | 2k-line module, no state machine | Channels |
| Vendure | GraphQL | Yes, channel token header | `@VendurePlugin` + 60+ strategies | Extensible state machines | Channels |
| Sylius | REST (API Platform) | Yes, separate firewalls | Bundles, decoration, tagged services | Workflow state machine + processor chain | Channels |
| Shopware | REST + OpenAPI | Yes, route scopes | Plugins + out-of-process apps + Flow Builder | Collector/processor pipeline; state machines as data | Sales channels |

## What we adopt, and from where

| Idea | Source | ADR |
|---|---|---|
| Module-owned tables, no cross-module foreign keys | Medusa | 0002 |
| Separate Store/Admin APIs with separate auth | Sylius, Shopware, Vendure, Medusa | 0003 |
| Typed error results instead of exceptions | Vendure | 0003 |
| Commands for cart and checkout operations | Sylius | 0003 |
| Channel selected by a token header | Shopware, Vendure, Medusa | 0004 |
| Explicit checkout/order/payment/fulfillment state machines | Sylius, Vendure, Shopware | 0005 |
| Compensating completion workflow, lock, idempotency | Medusa | 0005 |
| Ordered totals pipeline with typed adjustments, integer money | Sylius, Shopware, OpenCart, Vendure | 0006 |
| Rule-based price sets, price lists | Medusa, Sylius | 0007 |
| Reservations vs allocations, multi-location stock | Saleor, Medusa, Vendure | 0007 |
| Stock movement ledger | ERPNext, Vendure | 0007 |
| Payment transaction ledger | Saleor | 0007 |
| Capture immediately by default; authorize-only as a per-channel choice; partial capture | Saleor, Sylius, Medusa | 0019 |
| Test payment provider kept out of non-test environments | Shopware | 0019 |
| Typed config schemas that render admin forms | Vendure | 0008 |
| Out-of-process apps: manifest, HMAC, circuit breaker | Saleor, Shopware | 0008 |
| Named UI slots | nopCommerce, Sylius, Saleor | 0008 |
| One image, several process roles | frappe_docker, Medusa, Vendure | 0009 |
| Transactional outbox for events and webhooks | Shopware (2026 ADR) | 0009 |
| ADR discipline | Shopware, Sylius | 0001 |
| E2E harness that boots a real server; UI+API scenarios; plain-English e2e tests | Vendure, Sylius, nopCommerce/OpenCart (testRigor) | 0011 |

## What we deliberately avoid

| Pitfall | Seen in | Instead |
|---|---|---|
| Storefront that bypasses its own API | Shopware | Reference storefront uses the SDK over HTTP (0003) |
| One API with field-level permissions | Saleor | Two APIs (0003) |
| Two parallel extension systems | Saleor, Shopware | One contract, two runtimes (0008) |
| "Decorate anything" extensibility | Shopware, Sylius | Explicit, typed extension points (0008) |
| Exact-version plugin compatibility | nopCommerce | Semver extension contracts (0008) |
| Background work inside the web process | nopCommerce, OpenCart | Worker and scheduler roles (0009) |
| Redis/search engine as hard requirements | Medusa, Shopware, Saleor | Postgres only; others optional (0009) |
| Supporting several databases | nopCommerce, Frappe, Vendure | Postgres only (0009) |
| String-concatenated SQL, schema as an array | OpenCart | Kysely + migrations owned by each module (0010) |
| Monolithic checkout services | nopCommerce, Saleor | State machine + saga steps (0005) |
| Implicit checkout state | Medusa, Saleor | Declared state machine (0005) |
| Recalculating everything on every step | Sylius, Saleor | Recompute on input change (0006) |
| Dummy payment handlers that ship to production unnoticed | Vendure (project template), Medusa | Env flag, off unless set, plus startup warnings (0019) |
| Authorizations left to lapse silently | all eight | Expiry recorded per payment; a warning event 48 hours ahead (0019) |
