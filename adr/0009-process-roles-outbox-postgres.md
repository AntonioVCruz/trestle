# 0009. Process roles, transactional outbox, Postgres-only

- Status: Accepted
- Date: 2026-10-02

## Context

- **Background work inside the web process:** nopCommerce schedules tasks in-process, and
  OpenCart relies on a cron script.
- **Separate processes:** frappe_docker runs one image as backend, workers and scheduler.
  Medusa has a worker mode, Vendure a worker process, Saleor Celery.
- **Operational weight:**
  - Medusa effectively needs Redis in production.
  - Shopware needs MySQL, OpenSearch and Redis.
  - Saleor needs Redis or SQS for Celery.
  - nopCommerce and Frappe each maintain support for several databases.
- **Shopware's 2026 webhook-outbox ADR:** it gives webhooks their own outbox queue instead of the
  shared async queue.

## Decision

- **One image, five roles**, chosen by the first argument (`apps/server/src/main.ts`):
  - `web` serves both APIs.
  - `worker` delivers outbox events and, later, jobs.
  - `scheduler` runs periodic tasks and is leader-elected with a Postgres advisory lock.
  - `migrate` is one-shot.
  - `openapi` writes the specs.
- **Migrations never run implicitly on web start.** `migrate` takes an advisory lock, so
  concurrent deploys serialize.
- **Transactional outbox:** a module records an event in the transaction that changes state. The
  worker delivers events in order, at least once, with `FOR UPDATE SKIP LOCKED` batches.
  Delivered events are pruned after 7 days.
- **Postgres is the only required infrastructure:** data, outbox, queue, locks and scheduler
  leadership. Redis, a search engine and a CDN are optional providers when scale requires them.

## Consequences

- A local or small production deployment is Postgres plus one image (`compose.yaml`).
- Handlers must be idempotent (at-least-once delivery). Today one failing handler blocks its
  batch. Per-subscriber delivery state, retries with backoff and dead-lettering are needed before
  extensions can subscribe.
- Postgres-specific features (advisory locks, `SKIP LOCKED`, `jsonb`, arrays) are used freely.
