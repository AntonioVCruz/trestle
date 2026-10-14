import type { Migration } from '../../kernel/module.js';

export const migrations: readonly Migration[] = [
  {
    id: '0001_create_cart',
    sql: `
      -- channel_id belongs to the channel module: a plain id with no foreign key (ADR 0002).
      create table cart (
        id text primary key,
        channel_id text not null,
        currency text not null check (currency ~ '^[A-Z]{3}$'),
        subtotal bigint not null default 0,
        adjustments jsonb not null default '[]',
        adjustments_total bigint not null default 0,
        total bigint not null default 0 check (total >= 0),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      -- variant_id and product_id belong to the catalog; titles are copies taken when priced.
      create table cart_line (
        id text primary key,
        cart_id text not null references cart (id) on delete cascade,
        variant_id text not null,
        product_id text not null,
        product_handle text not null,
        product_title text not null,
        variant_title text not null,
        sku text,
        quantity integer not null check (quantity >= 1),
        unit_price bigint not null check (unit_price >= 0),
        original_unit_price bigint,
        subtotal bigint not null,
        total bigint not null,
        available boolean not null,
        created_at timestamptz not null default now(),
        unique (cart_id, variant_id)
      );
    `,
  },
  {
    id: '0002_add_checkout',
    sql: `
      -- Checkout steps collect their data on the cart (ADR 0016). States come from the checkout
      -- state machine (ADR 0005). shipping_option_id belongs to the shipping module: a plain id.
      alter table cart
        add column checkout_state text not null default 'cart'
          check (checkout_state in ('cart', 'addressed', 'shipping_selected', 'payment_selected', 'completing', 'placed')),
        add column email text,
        add column shipping_address jsonb,
        add column billing_address jsonb,
        add column shipping_option_id text,
        add column shipping_option_name text,
        add column shipping_amount bigint check (shipping_amount >= 0),
        add constraint cart_shipping_complete check (
          (shipping_option_id is null) = (shipping_option_name is null)
          and (shipping_option_id is null) = (shipping_amount is null)
        );
    `,
  },
  {
    id: '0003_add_payment_step',
    sql: `
      -- The chosen payment method (ADR 0017). payment_session_id belongs to the payments module.
      alter table cart
        add column payment_provider_id text,
        add column payment_provider_name text,
        add column payment_session_id text,
        add column payment_amount bigint check (payment_amount >= 0),
        add column payment_client_data jsonb,
        add constraint cart_payment_complete check (
          num_nulls(payment_provider_id, payment_provider_name, payment_session_id, payment_amount, payment_client_data)
            in (0, 5)
        );
    `,
  },
  {
    id: '0004_add_completion',
    sql: `
      -- Completion (ADR 0018): the idempotency key of the attempt in progress, and the order the
      -- cart became. order_id belongs to the orders module: a plain id.
      alter table cart
        add column completion_key text,
        add column completion_started_at timestamptz,
        add column order_id text,
        add constraint cart_completion_key check (
          (checkout_state = 'completing') = (completion_key is not null)
          and (completion_key is null) = (completion_started_at is null)
        ),
        add constraint cart_placed_order check ((checkout_state = 'placed') = (order_id is not null));
    `,
  },
];
