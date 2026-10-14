import type { Migration } from '../../kernel/module.js';

export const migrations: readonly Migration[] = [
  {
    id: '0001_create_payments',
    sql: `
      -- Which registered providers each channel offers. channel_id belongs to the channel module.
      create table payment_provider_channel (
        provider_id text not null,
        channel_id text not null,
        primary key (provider_id, channel_id)
      );
      create index payment_provider_channel_channel_idx on payment_provider_channel (channel_id);

      -- A payment prepared for a cart (ADR 0017). cart_id and channel_id are plain ids.
      -- Authorization, capture and refunds become a transaction ledger with orders (ADR 0007).
      create table payment_session (
        id text primary key,
        cart_id text not null,
        channel_id text not null,
        provider_id text not null,
        currency text not null check (currency ~ '^[A-Z]{3}$'),
        amount bigint not null check (amount >= 0),
        status text not null default 'pending' check (status in ('pending', 'failed')),
        reference text,
        data jsonb not null default '{}',
        client_data jsonb not null default '{}',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index payment_session_cart_idx on payment_session (cart_id);
    `,
  },
  {
    id: '0002_add_transaction_ledger',
    sql: `
      alter table payment_session drop constraint payment_session_status_check;
      alter table payment_session add constraint payment_session_status_check
        check (status in ('pending', 'requires_action', 'authorized', 'canceled', 'failed'));

      -- Append-only: every call to a provider that moves or reserves money (ADR 0007, ADR 0018).
      create table payment_transaction (
        id text primary key,
        session_id text not null references payment_session (id),
        kind text not null check (kind in ('authorize', 'capture', 'cancel', 'refund')),
        status text not null check (status in ('succeeded', 'failed', 'requires_action', 'error')),
        currency text not null,
        amount bigint not null check (amount >= 0),
        reference text,
        reason text,
        idempotency_key text not null,
        created_at timestamptz not null default now()
      );
      create index payment_transaction_session_idx on payment_transaction (session_id, created_at);
    `,
  },
  {
    id: '0003_add_capture',
    sql: `
      -- How each channel captures a provider's payments (ADR 0019).
      alter table payment_provider_channel add column capture_mode text not null default 'immediate'
        check (capture_mode in ('immediate', 'manual'));

      alter table payment_session drop constraint payment_session_status_check;
      alter table payment_session add constraint payment_session_status_check
        check (status in ('pending', 'requires_action', 'authorized', 'partially_captured', 'captured', 'canceled', 'failed'));
      alter table payment_session
        add column capture_mode text not null default 'immediate' check (capture_mode in ('immediate', 'manual')),
        add column captured_amount bigint not null default 0,
        add column authorization_expires_at timestamptz,
        add column expiry_warned_at timestamptz,
        add column capture_started_at timestamptz,
        add constraint payment_session_captured_amount_check check (captured_amount between 0 and amount);
      create index payment_session_expiry_idx on payment_session (authorization_expires_at)
        where expiry_warned_at is null and status in ('authorized', 'partially_captured');
      create index payment_session_awaiting_capture_idx on payment_session (updated_at)
        where status = 'authorized' and capture_mode = 'immediate';
    `,
  },
];
