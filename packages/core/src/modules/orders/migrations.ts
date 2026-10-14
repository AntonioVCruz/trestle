import type { Migration } from '../../kernel/module.js';

export const migrations: readonly Migration[] = [
  {
    id: '0001_create_sales_order',
    sql: `
      -- "order" is reserved in SQL. Ids of other modules' records are plain ids (ADR 0002).
      -- One cart places at most one order: the unique cart_id makes placing idempotent (ADR 0018).
      create table sales_order (
        id text primary key,
        number bigint generated always as identity (start with 1001) unique,
        cart_id text not null constraint sales_order_cart_key unique,
        channel_id text not null,
        status text not null default 'placed' check (status in ('placed', 'completed', 'canceled')),
        currency text not null check (currency ~ '^[A-Z]{3}$'),
        email text not null,
        shipping_address jsonb not null,
        billing_address jsonb not null,
        shipping_method jsonb not null,
        subtotal bigint not null,
        adjustments jsonb not null,
        adjustments_total bigint not null,
        total bigint not null check (total >= 0),
        payment_provider_id text not null,
        payment_session_id text not null,
        placed_at timestamptz not null default now()
      );
      create index sales_order_channel_idx on sales_order (channel_id, id);

      create table sales_order_line (
        id text primary key,
        order_id text not null references sales_order (id) on delete cascade,
        position integer not null,
        variant_id text not null,
        product_id text not null,
        product_handle text not null,
        product_title text not null,
        variant_title text not null,
        sku text,
        quantity integer not null check (quantity >= 1),
        unit_price bigint not null,
        original_unit_price bigint,
        subtotal bigint not null,
        total bigint not null,
        unique (order_id, position)
      );
    `,
  },
];
