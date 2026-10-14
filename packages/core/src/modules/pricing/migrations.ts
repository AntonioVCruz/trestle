import type { Migration } from '../../kernel/module.js';

export const migrations: readonly Migration[] = [
  {
    id: '0001_create_pricing',
    sql: `
      create table price_list (
        id text primary key,
        name text not null,
        status text not null default 'draft' check (status in ('draft', 'active')),
        priority integer not null default 0,
        starts_at timestamptz,
        ends_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        check (starts_at is null or ends_at is null or ends_at > starts_at)
      );

      -- variant_id belongs to the catalog module: a plain id with no foreign key (ADR 0002).
      create table price_set (
        id text primary key,
        variant_id text not null constraint price_set_variant_key unique,
        created_at timestamptz not null default now()
      );

      -- channel_id belongs to the channel module: a plain id with no foreign key.
      create table price (
        id text primary key,
        price_set_id text not null references price_set (id) on delete cascade,
        price_list_id text references price_list (id) on delete cascade,
        currency text not null check (currency ~ '^[A-Z]{3}$'),
        amount bigint not null check (amount >= 0),
        channel_id text,
        min_quantity integer not null default 1 check (min_quantity >= 1),
        created_at timestamptz not null default now(),
        constraint price_scope_key unique nulls not distinct
          (price_set_id, price_list_id, currency, channel_id, min_quantity)
      );
      create index price_price_list_idx on price (price_list_id) where price_list_id is not null;
    `,
  },
  {
    id: '0002_add_price_list_type',
    sql: `
      -- Lists created so far were discounts, so they become sales (ADR 0014).
      alter table price_list
        add column type text not null default 'sale' check (type in ('sale', 'override'));
    `,
  },
];
