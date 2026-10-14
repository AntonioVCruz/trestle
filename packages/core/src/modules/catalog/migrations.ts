import type { Migration } from '../../kernel/module.js';

export const migrations: readonly Migration[] = [
  {
    id: '0001_create_catalog',
    sql: `
      create table product (
        id text primary key,
        handle text not null constraint product_handle_key unique,
        title text not null,
        description text,
        status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index product_status_idx on product (status, id);

      create table product_option (
        id text primary key,
        product_id text not null references product (id) on delete cascade,
        name text not null,
        position integer not null,
        unique (product_id, name)
      );

      create table product_option_value (
        id text primary key,
        option_id text not null references product_option (id) on delete cascade,
        value text not null,
        position integer not null,
        unique (option_id, value)
      );

      create table product_variant (
        id text primary key,
        product_id text not null references product (id) on delete cascade,
        sku text constraint product_variant_sku_key unique,
        title text not null,
        position integer not null,
        created_at timestamptz not null default now()
      );
      create index product_variant_product_idx on product_variant (product_id, position);

      create table product_variant_option_value (
        variant_id text not null references product_variant (id) on delete cascade,
        option_value_id text not null references product_option_value (id) on delete cascade,
        primary key (variant_id, option_value_id)
      );

      create table category (
        id text primary key,
        parent_id text references category (id),
        handle text not null constraint category_handle_key unique,
        name text not null,
        position integer not null default 0,
        created_at timestamptz not null default now()
      );

      create table product_category (
        product_id text not null references product (id) on delete cascade,
        category_id text not null references category (id) on delete cascade,
        primary key (product_id, category_id)
      );
      create index product_category_category_idx on product_category (category_id, product_id);

      -- channel_id belongs to the channel module: a plain id with no foreign key (ADR 0002).
      create table product_channel (
        product_id text not null references product (id) on delete cascade,
        channel_id text not null,
        primary key (product_id, channel_id)
      );
      create index product_channel_channel_idx on product_channel (channel_id, product_id);
    `,
  },
];
