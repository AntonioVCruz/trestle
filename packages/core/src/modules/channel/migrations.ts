import type { Migration } from '../../kernel/module.js';

export const migrations: readonly Migration[] = [
  {
    id: '0001_create_channel',
    sql: `
      create table channel (
        id text primary key,
        code text not null unique,
        name text not null,
        default_currency text not null check (default_currency ~ '^[A-Z]{3}$'),
        currencies text[] not null check (default_currency = any (currencies)),
        default_locale text not null,
        locales text[] not null check (default_locale = any (locales)),
        created_at timestamptz not null default now()
      );

      create table channel_publishable_key (
        key text primary key,
        channel_id text not null references channel (id) on delete cascade,
        created_at timestamptz not null default now(),
        revoked_at timestamptz
      );
      create index channel_publishable_key_channel_idx on channel_publishable_key (channel_id);
    `,
  },
];
