import type { Generated } from 'kysely';

export interface ChannelTable {
  id: string;
  code: string;
  name: string;
  default_currency: string;
  currencies: string[];
  default_locale: string;
  locales: string[];
  created_at: Generated<Date>;
}

export interface ChannelPublishableKeyTable {
  key: string;
  channel_id: string;
  created_at: Generated<Date>;
  revoked_at: Date | null;
}

export type ChannelTables = {
  channel: ChannelTable;
  channel_publishable_key: ChannelPublishableKeyTable;
};
