import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from 'typebox';
import type { ChannelService, PaymentProviderInfo, PaymentsService, SetProviderChannelsError } from '@trestle/core';
import { errorBody, ErrorSchema } from './schemas.js';

export interface PaymentsRoutesOptions {
  readonly payments: PaymentsService;
  readonly channels: Pick<ChannelService, 'getById'>;
}

const captureMode = (options: { default?: string } = {}) =>
  Type.Enum(['immediate', 'manual'], {
    description: 'immediate: captured as soon as the order is placed. manual: authorized only; capture it from the order',
    ...options,
  });

export const PaymentProviderSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    supportsDeferredCapture: Type.Boolean({ description: 'Whether channels may capture its payments manually' }),
    testMode: Type.Boolean({ description: 'Moves no real money; never enable it on a live channel' }),
    channels: Type.Array(Type.Object({ channelId: Type.String(), captureMode: captureMode() }), {
      description: 'Channels whose shoppers are offered this provider',
    }),
  },
  { $id: 'PaymentProvider' },
);
type PaymentProviderDto = Static<typeof PaymentProviderSchema>;

export const PaymentProviderListSchema = Type.Object(
  { data: Type.Array(Type.Ref('PaymentProvider')) },
  { $id: 'PaymentProviderList' },
);

export const SetPaymentProviderChannelsSchema = Type.Object(
  {
    channels: Type.Array(
      Type.Object(
        { channelId: Type.String(), captureMode: Type.Optional(captureMode({ default: 'immediate' })) },
        { additionalProperties: false },
      ),
      { description: 'Each channel at most once' },
    ),
  },
  { $id: 'SetPaymentProviderChannels', additionalProperties: false },
);

export const paymentsSchemas = [PaymentProviderSchema, PaymentProviderListSchema, SetPaymentProviderChannelsSchema];

const SET_CHANNELS_STATUS: Record<SetProviderChannelsError['code'], 400 | 404 | 409> = {
  invalid_input: 400,
  payment_provider_not_found: 404,
  deferred_capture_unsupported: 409,
};

const toProviderDto = (provider: PaymentProviderInfo): PaymentProviderDto => ({
  ...provider,
  channels: provider.channels.map((c) => ({ ...c })),
});

/**
 * Providers are registered in code by the deployment (ADR 0017); merchants only choose which
 * channels offer them, and how each channel captures (ADR 0019).
 */
export const paymentsRoutes: FastifyPluginAsyncTypebox<PaymentsRoutesOptions> = async (app, { payments, channels }) => {
  app.get(
    '/payment-providers',
    {
      schema: {
        operationId: 'listPaymentProviders',
        summary: 'Payment providers registered in this deployment',
        tags: ['payments'],
        response: { 200: Type.Ref('PaymentProviderList'), 401: ErrorSchema },
      },
    },
    async () => ({ data: (await payments.listProviders()).map(toProviderDto) }),
  );

  app.put(
    '/payment-providers/:id/channels',
    {
      schema: {
        operationId: 'setPaymentProviderChannels',
        summary: 'Replace the channels that offer a payment provider, and how each captures',
        tags: ['payments'],
        params: Type.Object({ id: Type.String() }),
        body: SetPaymentProviderChannelsSchema,
        response: { 200: Type.Ref('PaymentProvider'), 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (request, reply) => {
      for (const { channelId } of request.body.channels) {
        if (!(await channels.getById(channelId))) {
          return reply.code(400).send(errorBody('channel_not_found', `Channel "${channelId}" not found`));
        }
      }
      const result = await payments.setProviderChannels(request.params.id, request.body.channels);
      if (!result.ok) return reply.code(SET_CHANNELS_STATUS[result.error.code]).send(errorBody(result.error.code, result.error.message));
      return toProviderDto(result.value);
    },
  );
};
