import { defineModule } from '../../kernel/module.js';
import { migrations } from './migrations.js';
import { createChannelService } from './service.js';

export const channelModule = defineModule({
  name: 'channel',
  migrations,
  createService: createChannelService,
});

export {
  CHANNEL_CREATED,
  type Channel,
  type ChannelService,
  type CreateChannelError,
  type CreateChannelInput,
  type CreatePublishableKeyError,
  type PublishableKey,
} from './service.js';
