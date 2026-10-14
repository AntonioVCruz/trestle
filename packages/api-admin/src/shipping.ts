import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { ChannelService, ShippingPriceInput, ShippingService, UpdateShippingOptionError } from '@trestle/core';
import {
  CreateShippingOptionSchema,
  errorBody,
  ErrorSchema,
  toShippingOptionDto,
  UpdateShippingOptionSchema,
  type ErrorBody,
} from './schemas.js';

export interface ShippingRoutesOptions {
  readonly shipping: ShippingService;
  readonly channels: Pick<ChannelService, 'getById'>;
}

const UPDATE_STATUS: Record<UpdateShippingOptionError['code'], 400 | 404> = {
  invalid_input: 400,
  shipping_option_not_found: 404,
};

// Responses refer to shared schemas by id; see the note in catalog.ts.
const ShippingOption = Type.Ref('ShippingOption');

export const shippingRoutes: FastifyPluginAsyncTypebox<ShippingRoutesOptions> = async (app, { shipping, channels }) => {
  /** The channel must exist and sell in every currency priced (ADR 0002: checked via its service). */
  async function checkChannel(channelId: string, prices: readonly ShippingPriceInput[]): Promise<ErrorBody | undefined> {
    const channel = await channels.getById(channelId);
    if (!channel) return errorBody('channel_not_found', `Channel "${channelId}" not found`);
    const foreign = prices.find((p) => !channel.currencies.includes(p.currency));
    if (foreign) return errorBody('currency_not_in_channel', `Channel "${channel.code}" does not sell in ${foreign.currency}`);
    return undefined;
  }

  app.get(
    '/shipping-options',
    {
      schema: {
        operationId: 'listShippingOptions',
        tags: ['shipping'],
        querystring: Type.Object({ channelId: Type.Optional(Type.String()) }),
        response: { 200: Type.Ref('ShippingOptionList'), 401: ErrorSchema },
      },
    },
    async (request) => ({ data: (await shipping.listOptions(request.query)).map(toShippingOptionDto) }),
  );

  app.post(
    '/shipping-options',
    {
      schema: {
        operationId: 'createShippingOption',
        tags: ['shipping'],
        body: CreateShippingOptionSchema,
        response: { 201: ShippingOption, 400: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (request, reply) => {
      const invalid = await checkChannel(request.body.channelId, request.body.prices);
      if (invalid) return reply.code(400).send(invalid);
      const result = await shipping.createOption(request.body);
      if (!result.ok) return reply.code(400).send(errorBody(result.error.code, result.error.message));
      return reply.code(201).send(toShippingOptionDto(result.value));
    },
  );

  app.patch(
    '/shipping-options/:id',
    {
      schema: {
        operationId: 'updateShippingOption',
        tags: ['shipping'],
        params: Type.Object({ id: Type.String() }),
        body: UpdateShippingOptionSchema,
        response: { 200: ShippingOption, 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (request.body.prices) {
        const option = await shipping.getOption(id);
        if (!option) return reply.code(404).send(errorBody('shipping_option_not_found', `Shipping option "${id}" not found`));
        const invalid = await checkChannel(option.channelId, request.body.prices);
        if (invalid) return reply.code(400).send(invalid);
      }
      const result = await shipping.updateOption(id, request.body);
      if (!result.ok) return reply.code(UPDATE_STATUS[result.error.code]).send(errorBody(result.error.code, result.error.message));
      return toShippingOptionDto(result.value);
    },
  );
};
