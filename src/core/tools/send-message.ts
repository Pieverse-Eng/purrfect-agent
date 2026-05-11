/**
 * send_message tool — allows the agent to send a message to any connected
 * platform via the DeliveryRouter.
 */

import type { ToolDefinition } from "../types.js";
import { DeliveryRouter } from "../../gateway/delivery.js";
import type { BaseAdapter } from "../../gateway/adapter.js";

/**
 * Options for creating a send_message tool with optional origin context.
 * When originAdapter and originChatId are provided, the "origin" target
 * will route to that adapter/chatId.
 */
export interface SendMessageToolOptions {
  router: DeliveryRouter;
  originAdapter?: BaseAdapter;
  originChatId?: string;
}

/**
 * Factory that creates a send_message ToolDefinition wired to the given
 * DeliveryRouter instance.
 *
 * Accepts either a DeliveryRouter directly (backward-compatible) or
 * a SendMessageToolOptions object with optional origin context.
 */
export function createSendMessageTool(
  routerOrOptions: DeliveryRouter | SendMessageToolOptions,
): ToolDefinition {
  const options: SendMessageToolOptions =
    routerOrOptions instanceof DeliveryRouter
      ? { router: routerOrOptions }
      : routerOrOptions;

  const { router, originAdapter, originChatId } = options;

  return {
    name: "send_message",
    description:
      'Send a message to a target destination. Use "origin" to reply to the source, or "platform:chatId" (e.g. "telegram:123") for a specific destination.',
    schema: {
      type: "function",
      function: {
        name: "send_message",
        description:
          'Send a message to a target destination. Use "origin" to reply to the source, or "platform:chatId" for a specific destination.',
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description:
                'The delivery target. "origin" for the source adapter, or "platform:chatId" for explicit routing.',
            },
            content: {
              type: "string",
              description: "The text content to send.",
            },
          },
          required: ["target", "content"],
        },
      },
    },

    async handler(args: Record<string, unknown>): Promise<string> {
      const target = args.target as string;
      const content = args.content as string;
      const result = await router.deliver(target, content, originAdapter, originChatId);
      return JSON.stringify(result);
    },
  };
}
