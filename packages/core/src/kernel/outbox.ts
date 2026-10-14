import { sql, type ColumnType, type Generated, type Kysely } from 'kysely';
import type { CoreDatabase } from './db.js';
import type { MigrationSource } from './module.js';

/**
 * Transactional outbox (ADR 0009). Modules record events in the same transaction as the state
 * change; the worker role delivers them afterwards. Extensions therefore never observe a change
 * that was rolled back, and no event is lost if the process dies after commit.
 */

export interface OutboxEventTable {
  id: Generated<string>;
  topic: string;
  payload: ColumnType<unknown, string, never>;
  occurred_at: Generated<Date>;
  published_at: Date | null;
}

export type OutboxTables = {
  outbox_event: OutboxEventTable;
};

export interface OutboxEvent {
  readonly id: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly occurredAt: Date;
}

export type EventHandler = (event: OutboxEvent) => Promise<void>;

export const kernelMigrations: MigrationSource = {
  name: 'kernel',
  migrations: [
    {
      id: '0001_create_outbox_event',
      sql: `
        create table outbox_event (
          id bigint generated always as identity primary key,
          topic text not null,
          payload jsonb not null,
          occurred_at timestamptz not null default now(),
          published_at timestamptz
        );
        create index outbox_event_pending_idx on outbox_event (id) where published_at is null;
      `,
    },
  ],
};

/** Record an event. Pass the transaction that performs the state change. */
export async function recordEvent(db: Kysely<any>, topic: string, payload: unknown): Promise<void> {
  await sql`insert into outbox_event (topic, payload) values (${topic}, ${JSON.stringify(payload)}::jsonb)`.execute(db);
}

/**
 * Deliver one batch of pending events, in order, at least once. A failing handler rolls back the
 * whole batch so it is retried on the next poll. `skip locked` lets several workers share the
 * table without double delivery inside a batch.
 */
export async function drainOutbox(
  database: CoreDatabase,
  handlers: ReadonlyMap<string, readonly EventHandler[]>,
  batchSize = 100,
): Promise<number> {
  const db = database.withTables<OutboxTables>();
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('outbox_event')
      .select(['id', 'topic', 'payload', 'occurred_at'])
      .where('published_at', 'is', null)
      .orderBy('id')
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();
    if (rows.length === 0) return 0;

    for (const row of rows) {
      const event: OutboxEvent = { id: row.id, topic: row.topic, payload: row.payload, occurredAt: row.occurred_at };
      for (const handler of handlers.get(row.topic) ?? []) await handler(event);
    }

    await trx
      .updateTable('outbox_event')
      .set({ published_at: sql<Date>`now()` })
      .where(
        'id',
        'in',
        rows.map((row) => row.id),
      )
      .execute();
    return rows.length;
  });
}

/** Delete delivered events older than `before`. Returns the number removed. */
export async function pruneOutbox(database: CoreDatabase, before: Date): Promise<number> {
  const result = await database
    .withTables<OutboxTables>()
    .deleteFrom('outbox_event')
    .where('published_at', '<', before)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
