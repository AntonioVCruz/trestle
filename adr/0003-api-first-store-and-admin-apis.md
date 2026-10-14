# 0003. API-first: separate Store and Admin REST APIs with OpenAPI

- Status: Accepted
- Date: 2026-10-02

## Context

- OpenCart and nopCommerce have no usable storefront API (nopCommerce's Web API is a commercial
  add-on). ERPNext generates REST per DocType, which exposes its internal schema.
- Saleor exposes one GraphQL API and controls storefront access field by field through
  permissions, which leaves a large surface and a lot of complexity.
- Medusa, Vendure, Sylius and Shopware all split a Store API from an Admin API, each with its own
  authentication: Sylius uses separate firewalls, Shopware uses route scopes.
- Shopware's own storefront calls Store API PHP classes in-process, so the platform is not
  headless internally.
- Vendure returns typed error results instead of exceptions.

## Decision

- Two APIs, served by the `web` process under versioned prefixes: `/store/v1` and `/admin/v1`.
  Each is a separate Fastify plugin with its own authentication hook, error handler, schemas and
  OpenAPI document (`/store/v1/openapi.json`, `/admin/v1/openapi.json`).
- REST + JSON, with request and response schemas declared in TypeBox. The schemas drive
  validation, serialization and OpenAPI. Catalog reads are designed to be HTTP-cacheable.
- Cart and checkout operations are command endpoints (e.g. `POST /store/v1/carts/{id}/complete`)
  rather than generic PATCHes, so each step validates and transitions explicitly.
- Expected failures come back as a `Result` from services and become
  `{ "error": { "code", "message" } }` with a specific status. Exceptions mean bugs.
- `@trestle/sdk` is generated from the OpenAPI documents. The reference storefront and admin
  use only the SDK over HTTP and never import core.
- The generated OpenAPI documents are committed (`openapi/`), so API changes show up in review.

## Consequences

- Third parties get exactly the capabilities our own front ends have.
- Changing an API means regenerating (`npm run generate`) and reviewing the spec diff.
- GraphQL could be added later as a read layer over the same services if demand appears. It is
  not a goal now.
