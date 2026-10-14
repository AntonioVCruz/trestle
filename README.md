# Trestle

An open-source, API-first commerce platform. The core is a modular monolith. It serves a Store
API and an Admin API that are separate, each documented with OpenAPI. Extensions use one typed
contract, whether they run in-process or out-of-process as apps. The only required infrastructure
is Postgres.

> **Status: early.** The architecture is decided (`adr/`), and a first purchase works end to end
> through the public APIs: browse, cart, checkout, pay (with the test provider) and place the
> order. The reference storefront covers that whole flow. Inventory, promotions, tax,
> fulfillment, customer accounts and the admin UI are not built yet.

## Why another one?

We studied OpenCart, nopCommerce, ERPNext, Medusa, Saleor, Vendure, Sylius and Shopware
([`docs/benchmarks.md`](docs/benchmarks.md)). The gaps that remain:

- **One extension contract that is both typed and isolated**, rather than two parallel systems.
- **Checkout you can audit:** an explicit state machine, with a compensating saga for completion.
- **Headless in practice:** the bundled storefront and admin are ordinary SDK clients.
- **Light to run:** Postgres plus one container image.

## Layout

```
adr/                 architecture decision records (start here)
docs/benchmarks.md   what we learned from other platforms
openapi/             generated Store/Admin OpenAPI documents (committed)
packages/
  core/              kernel (money, state machines, totals, migrations, outbox) + modules
  api-store/         Store API: channel-scoped, public
  api-admin/         Admin API: authenticated back office
  sdk/               typed clients generated from openapi/
apps/
  server/            the deployable: web | worker | scheduler | migrate | openapi
  storefront/        reference storefront: Astro, Store API only (wireframes inside)
  admin/             admin SPA (not started)
```

## What works today

- The kernel:
  - integer `Money` with lossless `allocate()`
  - declarative state machines (the checkout machine is defined)
  - the ordered totals pipeline with typed adjustments
  - `Result` errors and prefixed time-ordered ids
  - migrations owned by each module, with an advisory-locked runner
  - the transactional outbox
- The **channel** module: channels and publishable keys.
- The **catalog** module (ADR 0013): products, options, variants, categories, and which channels
  list each product.
- The **pricing** module (ADR 0014): base prices per variant, scoped by currency, channel and
  quantity tier. Price lists add sales and overrides, with a priority and a validity window. One
  tested function resolves the price that applies.
- The **cart** module (ADR 0015): carts with lines, re-priced on every change, with totals from
  the adjuster pipeline stored on the cart. Lines that stop being sellable are kept and flagged.
- **Checkout steps** on the cart (ADR 0016, ADR 0017): email and addresses, a shipping method,
  then a payment method, driven by the checkout state machine. Shipping is the first totals
  adjuster.
- The **shipping** module (ADR 0016): flat-rate shipping options per channel, priced per currency
  and optionally limited to some countries.
- The **payments** module (ADR 0017, ADR 0019): the payment provider contract (v1.1), providers
  enabled per channel with a capture mode (`immediate` or `manual`), payment sessions, full and
  partial captures, an append-only transaction ledger, and a built-in `test` provider whose
  outcome the storefront chooses. The test provider is registered only when
  `ENABLE_TEST_PAYMENT_PROVIDER=true`.
- **Placing an order** (ADR 0018, ADR 0019): a saga that re-validates the cart, authorizes the
  payment, writes the order and then captures the payment where the channel captures
  immediately, with compensations, an idempotency key and recovery of abandoned attempts.
- The **orders** module (ADR 0018): orders as full copies of the cart, with sequential numbers.
- The **Admin API** (`/admin/v1`):
  - list and create channels, and issue publishable keys
  - create, list, update and publish products; add variants
  - set a product's channels and categories; create and list categories
  - set a variant's base prices; create, schedule and activate price lists and set their prices
  - create, update and list shipping options
  - list payment providers, choose which channels offer them and how each captures
  - list and view orders; view an order's payment and ledger; capture it in full or in part

  Auth is a bootstrap bearer token.
- The **Store API** (`/store/v1`): resolves the channel from `x-publishable-key`, then serves:
  - that channel
  - its published products, paged and filterable by category, and a product by handle, with
    each variant's current price (and the regular price during a sale) in any of the channel's
    currencies
  - the category list
  - carts: create one, read it, add lines, change quantities, remove lines
  - checkout: set email and addresses, choose a shipping method, choose a payment method, place
    the order
  - view an order
- **Process roles:**
  - `worker` delivers outbox events.
  - `scheduler` is leader-elected; it prunes delivered events, recovers abandoned order
    placements, retries immediate captures that did not happen, and warns about authorizations
    about to lapse.
  - `migrate` is one-shot.
- The **SDK**, generated from the committed specs.
- The **reference storefront** (ADR 0020, [`apps/storefront`](apps/storefront/README.md)): home,
  listings with Load more, product pages with option selection and sale prices, the cart drawer
  and cart page, a currency picker that locks to the cart's currency, four-step checkout with
  every failure screen, order confirmation, menus and error pages. Server-rendered with Astro, through the SDK only, and usable
  without JavaScript. `npm run seed` fills a demo channel through the Admin API.
- Tests: unit tests, architecture rules, API tests through `fastify.inject`, and Postgres
  integration tests for every module and for placing orders end to end (they run when
  `TEST_DATABASE_URL` is set).

## Quick start

Requires Node 22+ and Docker.

```sh
npm install
npm test

# Full stack in containers
cp .env.example .env     # sets ADMIN_API_TOKEN=change-me; pick your own
docker compose up -d --build
npm run seed             # demo channel and catalog; add the key it prints to .env
docker compose up -d storefront   # the reference storefront on http://localhost:4321
```

The storefront needs a channel's publishable key, which exists only once the stack is seeded,
so a plain `docker compose up` leaves it out. `WEB_PORT` and `STOREFRONT_PORT` move the
published ports. To make a channel by hand instead of seeding:

```sh
curl -s -X POST localhost:9000/admin/v1/channels \
  -H 'authorization: Bearer change-me' -H 'content-type: application/json' \
  -d '{"code":"eu","name":"EU store","defaultCurrency":"EUR","defaultLocale":"en"}'
curl -s -X POST localhost:9000/admin/v1/channels/<id>/publishable-keys \
  -H 'authorization: Bearer change-me'
curl -s localhost:9000/store/v1/channel -H 'x-publishable-key: <key>'
```

To develop against source with reload, run the server on the host instead:

```sh
docker compose up -d postgres
cp .env.example .env     # the npm scripts load it; compose reads ADMIN_API_TOKEN and the key
npm run migrate
npm run dev              # web with reload; npm run worker / npm run scheduler in other shells
npm run seed             # demo channel and catalog; add the key it prints to .env
npm run storefront       # the reference storefront on http://localhost:4321
```

## Scripts

| Script | Does |
|---|---|
| `npm test` | Vitest across all packages. Set `TEST_DATABASE_URL` to include Postgres integration tests; each suite uses a throwaway schema |
| `npm run typecheck` | Type-checks sources and tests, then the storefront with `astro check` |
| `npm run build` | `tsc -b` into each package's `dist/`, then builds the storefront |
| `npm run generate` | Rewrites `openapi/*.json` and the SDK types; commit the diff |
| `npm run dev` / `worker` / `scheduler` / `migrate` | Run a role from source |
| `npm run storefront` | The reference storefront with reload |
| `npm run seed` | Creates a demo channel and catalog through the Admin API, and prints a publishable key |

## Suggested next steps

1. testRigor end-to-end scenarios for the purchase flow on the reference storefront (ADR 0011).
2. Inventory (stock per location, with reservations as a step in placing an order); then capture
   at fulfillment as a third capture mode (ADR 0019).
3. A Stripe payment provider, with provider config schemas (ADR 0008).
4. Admin authentication and RBAC, replacing `ADMIN_API_TOKEN`.
5. Promotions and tax as totals adjusters; outbox delivery tracked per subscriber; order emails.
6. Pricing follow-ups (ADR 0014): price history for the EU 30-day rule, customer-group prices,
   and the listing read model for sorting and filtering by price.
7. Catalog follow-ups: localized content, media, editing and removing options and variants.

## License

MIT (proposed; see ADR 0012). Contributions are accepted with a DCO sign-off.
