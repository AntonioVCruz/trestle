# 0020. The reference storefront: Astro, rendered on the server

- Status: Proposed
- Date: 2026-10-07
- Refines: ADR 0003 (the storefront is an SDK client), ADR 0008 (theme tokens, UI slots), ADR 0011
  (end-to-end tests run against it)

## Context

ADR 0003 says the reference storefront uses only `@trestle/sdk` over HTTP. Its README left the
framework open between Next.js and Astro. The wireframes (`apps/storefront/wireframes/`) specify
every page of the purchase flow. Most of each page is content: listings, product details, the
cart and order summaries. A few parts are interactive: the menus, option selection, the cart
drawer, and placing an order with retries.

What the benchmarks do:

- OpenCart, nopCommerce, Sylius and Shopware render their storefronts inside the platform
  process, with Twig or Razor templates. Shopware's storefront calls Store API classes
  in-process, which ADR 0003 rejects.
- Medusa and Saleor ship their storefronts as separate Next.js apps that call their public APIs.
  That keeps them honestly headless, but it ties every theme and extension to React and to a
  framework that changes quickly.

We want the storefront to be easy to run, to fork and to extend, and to work without
JavaScript where it reasonably can, because the testRigor suites of ADR 0011 drive it like a
shopper.

## Decision

- **Astro, rendered on demand** with the Node adapter (`output: 'server'`). Pages are HTML from
  the server. Client JavaScript is a few small scripts, written next to the component that
  needs them: the category menus, Load more and option selection for now.
- **All Store API calls happen on the storefront's server.** The browser talks only to the
  storefront: pages, form posts (`/currency`) and HTML fragments (`/fragments/products` for Load
  more). The publishable key never needs CORS or browser exposure, and a later cart can live in
  an HTTP-only cookie.
- **Progressive enhancement.** Without JavaScript, every flow still works:
  - Load more is a link to the next page.
  - Options are a form that submits.
  - The menus are `<details>` elements.
  - The mobile menu is a `<dialog>` opened by invoker commands, with a small fallback script for
    older browsers.

  Scripts only make these smoother.
- **Rules live in plain TypeScript modules** (`src/lib/`): money display, the price summary,
  the category tree and option selection. Vitest tests them, and the product page runs the same
  selection code on the server and in the browser.
- **Configuration at runtime:** `TRESTLE_API_URL` and `TRESTLE_PUBLISHABLE_KEY` through
  `astro:env`, read when the server runs, not inlined at build. One build serves any channel. In
  development they come from the repository's root `.env`.
- **Theme tokens are CSS custom properties** (`src/styles/tokens.css`). Components read only
  those, so a theme restyles the storefront without touching markup. UI slots (ADR 0008) come
  with the first extension that needs one.
- **Demo data comes from the Admin API.** `npm run seed` creates a channel, categories,
  products, prices, a sale, a shipping option and the test payment provider, through
  `@trestle/sdk`, never through core.
- The storefront is its own deployable. It is not part of the server image (ADR 0009).

## Consequences

- Third parties can see a complete storefront built only on public APIs; anything it does, they
  can do.
- Every page view costs at least two Store API calls (channel and categories, for navigation).
  If that shows up in latency, cache them briefly in the storefront; they change rarely.
- Without an island framework, each interactive part is a hand-written script. If the cart and
  checkout need more state than that comfortably holds, Astro can host islands of a UI library
  without changing this decision.
- Type checking needs `astro check`, so `npm run typecheck` runs it after `tsc`.
- Still to do: a container image and a compose service for the storefront; the cart, checkout
  and order pages; and the testRigor scenarios.
