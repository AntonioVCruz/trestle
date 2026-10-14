# Reference storefront wireframes

Low-fidelity wireframes for the reference storefront (`apps/storefront`): every page and state of
the purchase flow, mobile-first (375 px) with desktop (1280 px) where layout differs. They specify
structure, behaviour and data, not visual style. Each block is labelled with the Store API
endpoint it reads or writes, so the storefront can be built from them without guessing.

- **View:** the PNGs in [`screens/`](screens/), indexed below.
- **Edit:** `storefront-wireframes.dc.html` is the source, made with Claude Design. It needs the
  tool's runtime (`support.js`), which is not committed (see [Files](#files)). It also loads React,
  Babel and fonts from public CDNs, so it needs internet access to open. After editing, re-export
  the PNGs so they match.
- **Checks:** `wireframes.test.ts` runs with `npm test`. It fails if visible text contains
  `camelCase = value`, which Claude Design's runtime mangles: "nextCursor = null" renders as
  "sc-camel-next-cursor = null", so write "nextCursor is null". It also fails if a screen has no
  PNG or isn't in the index below.

## Legend

| Mark | Meaning |
|---|---|
| Blue dashed note with a tag (`CHANNEL`, `CATALOG`, `CART`, `CHECKOUT`, `ORDER`) | Where the data comes from, usually a Store API endpoint |
| Orange dashed outline, labelled **PLANNED** | Not in the Store API yet. Build it later, or leave it out; the flow works without it |
| Option chips: solid / outlined / struck dashed / faded dashed | Selected / available / out of stock (planned: needs inventory) / no such variant |
| Numbered blue dots | Keyboard focus order |

## Screens

**1 · The full flow**

| Screen | | Screen | |
|---|---|---|---|
| [1a](screens/1a.png) | Home, mobile | [1n](screens/1n.png) | Cart page, mobile |
| [1b](screens/1b.png) | Mobile menu, parent → child | [1o](screens/1o.png) | Cart page, desktop |
| [1c](screens/1c.png) | Home, desktop, category menu open | [1p](screens/1p.png) | Cart, empty |
| [1d](screens/1d.png) | Category, mobile | [1q](screens/1q.png) | Checkout flow and rules |
| [1e](screens/1e.png) | Category, desktop | [1r](screens/1r.png) | Step 1: address, with focus order |
| [1f](screens/1f.png) | Category, loading skeleton | [1s](screens/1s.png) | Step 2: shipping method |
| [1g](screens/1g.png) | Category, empty | [1t](screens/1t.png) | Step 3: payment |
| [1h](screens/1h.png) | Product, mobile | [1u](screens/1u.png) | Step 4: review and place order, desktop |
| [1i](screens/1i.png) | Product, desktop | [1v](screens/1v.png) | Placing your order… |
| [1j](screens/1j.png) | Product with no options | [1w](screens/1w.png) | Payment failed → back to step 3 |
| [1k](screens/1k.png) | Product, loading skeleton | [1x](screens/1x.png) | Order confirmation, mobile |
| [1l](screens/1l.png) | Spec: option value states | [1y](screens/1y.png) | Not found, mobile |
| [1m](screens/1m.png) | Cart drawer, desktop | [1z](screens/1z.png) | Not found, desktop |

**2 · Currency rule**: [2a](screens/2a.png) the mobile menu with the currency locked because the
cart has items; [2b](screens/2b.png) the rule itself.

**3 · API error and edge states**

| Screen | | API signal |
|---|---|---|
| [3a](screens/3a.png) | Sale "was" price on card, product, cart and order | `originalAmount` / `originalUnitPrice` |
| [3b](screens/3b.png) | Cart line no longer available | line `available: false`; `409 cart_not_ready` at completion |
| [3c](screens/3c.png) | Payment requires action | `409 payment_requires_action` with `error.details.clientData` |
| [3d](screens/3d.png) | Prices changed at review | `409 cart_changed` |
| [3e](screens/3e.png) | Order already being placed | `409 completion_in_progress` |
| [3f](screens/3f.png) | No shipping options for the address | `GET /carts/{id}/shipping-options` returns `[]` |
| [3g](screens/3g.png) | No payment methods in the channel | `GET /carts/{id}/payment-methods` returns `[]` |

## Rules the wireframes encode

These come from the platform's decisions; the storefront must follow them.

- **SDK only.** The storefront talks to the Store API through `@trestle/sdk` and never imports
  core (ADR 0003).
- **Totals come from the server.** The browser never sums prices. Struck "was" prices are display
  only.
- **Listings page by cursor.** "Load more" passes `nextCursor` back as `after`, and disappears when
  it is null (ADR 0013).
- **Checkout is four steps with shipping always required** (ADR 0016). Changing the shipping
  address drops the shipping method. A gift-card-only checkout is drawn as future work only.
- **A cart's currency is fixed at creation.** The picker is disabled while the cart has items (2b).
- **Placing the order** (ADR 0018):
  - Send one `Idempotency-Key` per tap of Place order, reused when retrying.
  - Retry on network errors, 5xx and `409 completion_in_progress`, or poll `GET /carts/{id}`
    until `orderId` is set. Stop on any other error.
  - A decline returns to the payment step with the cart, address and shipping intact (1w).
  - Price changes and required actions have their own screens (3c, 3d).
- **Accessibility is specified, not optional:** focus order, focus trapping in drawers and
  menus, live regions for status, `role="alert"` for errors, disabled options still announced,
  menus that open on click rather than hover only.

## Not covered yet

Ideas noted in the source as "try next": search results and a no-results page, a single-page
accordion alternative to the four checkout steps, alternative product option selectors, and 3d
on desktop.

## Files

| File | Committed | |
|---|---|---|
| `storefront-wireframes.dc.html` | yes | The source |
| `screens/*.png` | yes | One export per screen, cropped |
| `support.js` | no (gitignored) | Claude Design's generated runtime. It has no license we can redistribute under (ADR 0012), so it stays on the designer's machine |
| `.thumbnail` | no (gitignored) | The tool's preview image |
