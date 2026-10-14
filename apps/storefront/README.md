# apps/storefront — reference storefront

A server-rendered [Astro](https://astro.build) app (ADR 0020). It is an ordinary client of the
Store API: it uses `@trestle/sdk` over HTTP and never imports `@trestle/core` (ADR 0003). That
keeps the platform honestly headless; Shopware's storefront calling Store API classes in-process
is the anti-pattern we avoid.

The wireframes in [`wireframes/`](wireframes/README.md) specify every page and state of the
purchase flow.

## Run it

```sh
docker compose up -d postgres
npm run migrate
npm run dev           # the API on :9000
npm run seed          # demo channel and catalog; prints TRESTLE_PUBLISHABLE_KEY for .env
npm run storefront    # http://localhost:4321
```

Configuration is read at runtime, from the repository's root `.env` in development:

| Variable | Default | |
|---|---|---|
| `TRESTLE_API_URL` | `http://localhost:9000` | Where the Store API is |
| `TRESTLE_PUBLISHABLE_KEY` | (required) | Selects the channel (ADR 0004) |

`npm run build` builds it into `dist/`, with its runtime dependencies bundled in. Run it with
`npm run start -w @trestle/storefront` (`HOST` and `PORT` set the address). It refuses to start
without `TRESTLE_PUBLISHABLE_KEY`.

## Container image

The storefront has its own image, separate from the server's. With the rest of the stack, run it
through compose: `docker compose up -d storefront` (see the root README). To build and run the
image on its own, from the repository root:

```sh
docker build -f apps/storefront/Dockerfile -t trestle-storefront .
docker run -p 4321:4321 -e TRESTLE_PUBLISHABLE_KEY=pk_… \
  -e TRESTLE_API_URL=http://host.docker.internal:9000 trestle-storefront
```

- **Small:** the image holds only `server.mjs` and the bundled `dist/`, with no `node_modules`.
  At about 240 MB it is essentially the `node:22-alpine` base. It runs as the `node` user.
- **Health:**
  - `/health/live` answers whenever the process is up. It is the image's `HEALTHCHECK`.
  - `/health/ready` returns 503 with a reason when the Store API is unreachable or rejects the
    key.
- **Any domain:** the image works behind any domain, proxy or port mapping. It trusts the
  `Host` header (see `astro.config.mjs`), so its own form posts pass Astro's cross-site check
  while posts from other sites are still refused.

## What's built

The whole purchase flow, against every wireframe except the parts drawn PLANNED:

- **Home:** shop by category, and new arrivals.
- **Listings:** all products (`/products`) and each category (`/categories/{handle}`), with
  breadcrumbs, subcategory chips, Load more by cursor and an empty state.
- **Product page** (`/products/{handle}`):
  - option selection that follows the 1l rules
  - the shareable `?variant=` URL
  - sale prices with the "was" price struck through
- **Cart:**
  - Add to cart on the product page, which names what is missing ("Select a size") until a
    priced variant is picked.
  - The cart drawer (1m) and cart page (1n, 1o, 1p): change quantities and remove lines,
    with sale prices struck through and totals from the cart.
  - Lines that can no longer be bought (3b) are flagged and must be removed.
  - The cart id is kept in an HTTP-only cookie. A stale id is dropped, and the next add starts
    a new cart.
- **Checkout** (`/checkout/address`, `shipping`, `payment`, `review`; 1q–1w):
  - Four steps, each with its own URL. The cart's checkout state decides how far the shopper
    may go, and Review offers Edit for every part.
  - Step 1 checks the form before calling the API. Errors sit next to their fields, under a
    summary that takes focus.
  - The test payment provider lets the shopper choose what happens: success, decline,
    confirmation needed, or a declined capture.
  - Place order is a form post. The storefront server retries with the same Idempotency-Key on
    network errors, 5xx and `completion_in_progress`, then redirects. The browser only shows
    "Placing order…" (1v) and blocks a second tap.
- **When placing the order fails:**
  - Declined (1w): back to step 3, with the cart intact.
  - Confirmation needed (3c): for test payments, a stand-in "Approve or Fail" step.
  - Prices changed (3d): what changed and what it cost before, then choose payment again.
  - Already being placed (3e): a page that reloads itself until the order exists.
  - No shipping to the address (3f), or no payment methods (3g).
- **Confirmation** (1x): read from an HTTP-only cookie, so the order id never appears in a URL.
- **Currency picker,** remembered in a cookie. It locks to the cart's currency once the cart
  holds anything (2a, 2b); the server enforces this too.
- **Navigation:** the desktop category menu and the mobile menu.
- **Error pages:** not found (404), and a 500 page for when the Store API is unreachable.

Everything works without JavaScript; the scripts only make it smoother.

Not yet:

- **Next:** testRigor end-to-end scenarios for the purchase flow (ADR 0011).
- **Gaps in what the Store API returns:** the order has no payment method, and there are no
  per-channel countries or address formats. So the confirmation shows no payment row, and
  step 1 offers every country with a free-text region.
- **Waiting on other platform work:** order emails, so the confirmation doesn't claim one was
  sent; and real payment providers' hosted fields and confirmation steps.
- **Needs Store API support first:** search, images and stock badges, related products,
  localized content and the language picker. These are drawn PLANNED in the wireframes.
- **Placeholders:** the hero and promo strip, until there is channel content to fill them.
- **Not wired up:** UI slots for extensions (ADR 0008).
- **Discount codes and tax** in the cart summary wait for promotions and tax in the platform.

## Layout

```
src/
  lib/          rules as plain TypeScript, unit-tested: money, prices, categories, variants, cart
  middleware.ts loads the channel, category tree and cart for every page
  layouts/      the page shell, and the quieter checkout shell
  components/   header, menus, product card and grid, price, breadcrumb, cart drawer and lines
  pages/        routes; cart/ takes the cart's form posts; fragments/ serves Load more and the
                cart drawer; currency.ts takes the picker's post
  styles/       tokens.css (theme tokens), global.css and checkout.css
scripts/seed.ts demo data, through the Admin API
wireframes/     the specification
```
