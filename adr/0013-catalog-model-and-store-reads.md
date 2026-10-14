# 0013. Catalog model, channel visibility and Store API reads

- Status: Proposed
- Date: 2026-10-05

## Context

ADR 0007 sketches the catalog as Product → Variant → options. Building it raised questions that
0007 leaves open:

- OpenCart bolts variants onto a master product, and nopCommerce derives SKUs from attribute
  combinations. In both, a product without variants is a special case all the way down.
- Saleor lists products per channel. Medusa scopes products to sales channels, and Sylius enables
  products per channel.
- ADR 0002 says reads that span modules come from read models. Today the Store API's catalog
  reads use only catalog data, because pricing and inventory do not exist yet.

## Decision

- **Every product has at least one variant.** A product without options gets one `Default`
  variant, so carts, prices and stock always refer to a variant id. A product with options must
  list its variants explicitly. Each variant picks exactly one value per option, no two variants
  share a combination, and SKUs, when present, are unique across the catalog. These rules are
  pure functions (`modules/catalog/rules.ts`).
- **Handles** (`blue-t-shirt`) are the stable public names. They are unique across the catalog
  and are how the Store API addresses products and categories. Ids stay internal to admin
  workflows and carts.
- **Status** is a state machine: `draft → published → draft | archived`, with `archived → draft`
  only. Only `published` products reach the Store API.
- **Channel visibility** is a catalog table, `product_channel(product_id, channel_id)`. The
  channel id is a plain id with no foreign key (ADR 0002). The Admin API checks channel ids
  through the channel service before handing them to the catalog.
- **Categories** form a tree within the catalog (`parent_id`). They are not channel-scoped yet.
- **Store API reads come straight from the catalog's own tables.** Prices are added by
  composition at the API layer (ADR 0014). The listing read model of ADR 0002 gets built when a
  listing must be sorted or filtered by data from another module, such as price or stock. It
  will be fed by `product.*`, `variant.*` and pricing events. Building it now would duplicate
  the catalog tables with nothing to sort on.
- **Listings use keyset pagination**: newest first, with an opaque `nextCursor` passed back as
  `after`. Loading a page takes a fixed number of queries, whatever the page size. An
  integration test asserts this (ADR 0011).
- **Events**: `product.created`, `product.updated`, `variant.created` (also recorded for variants
  created with their product) and `category.created`, each written to the outbox in the same
  transaction as the change.

## Consequences

- Pricing and inventory can attach to variant ids from day one, with no special case for
  products that have no options.
- Store listings need no read model yet. It is a planned step with a known trigger (sorting or
  filtering by price or stock), not an open question.
- Not covered yet: localized titles and descriptions (channels already carry locales), media,
  removing or reordering options and variants, and channel-scoped category trees. Each will need
  a migration and may need its own ADR.
