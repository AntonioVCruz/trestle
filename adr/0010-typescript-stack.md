# 0010. TypeScript stack and tooling

- Status: Accepted
- Date: 2026-10-02

## Context

Medusa and Vendure show that TypeScript on Node carries a full commerce domain, and it lets the
server, SDK, storefront and admin share types. Their ORMs (MikroORM, TypeORM) are named as
coupling pains, and so is Shopware's custom DAL.

## Decision

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS+ | ESM, `node:` built-ins |
| Language | TypeScript 5.9, strict, `NodeNext` | `openapi-typescript` does not yet support TS 7 |
| HTTP | Fastify 5 | Encapsulated plugins give each API its own hooks, errors and spec |
| Schemas | TypeBox 1.x | One schema for validation, serialization and OpenAPI |
| OpenAPI | `@fastify/swagger`, one instance per API | Disjoint documents |
| Data access | Kysely + `pg` | Typed SQL without an ORM; `withTables` enforces module ownership |
| Migrations | Forward-only SQL per module, own runner | Modules own their schema |
| Logging | pino | Fastify's logger, structured JSON |
| SDK | openapi-typescript + openapi-fetch | Types from the committed specs; tiny runtime |
| Tests | Vitest | Fast and ESM-native |
| Workspace | npm workspaces, `tsc -b` project references | No extra tooling to install |

Workspace packages export a `source` condition. Dev (`tsx --conditions=source`) and tests run
from TypeScript sources; builds use `dist/`.

## Consequences

Few moving parts and no code generation for the data layer. Kysely table types are written by
hand next to each migration. If that becomes error-prone, a generator such as kysely-codegen can
check them against the database in CI.
