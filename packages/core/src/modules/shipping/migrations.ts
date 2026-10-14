import type { Migration } from '../../kernel/module.js';

export const migrations: readonly Migration[] = [
  {
    id: '0001_create_shipping_option',
    sql: `
      -- channel_id belongs to the channel module: a plain id with no foreign key (ADR 0002).
      create table shipping_option (
        id text primary key,
        channel_id text not null,
        name text not null,
        countries text[] check (countries is null or cardinality(countries) > 0),
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index shipping_option_channel_idx on shipping_option (channel_id);

      create table shipping_option_price (
        option_id text not null references shipping_option (id) on delete cascade,
        currency text not null check (currency ~ '^[A-Z]{3}$'),
        amount bigint not null check (amount >= 0),
        primary key (option_id, currency)
      );
    `,
  },
];
