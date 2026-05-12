/**
 * DeliveryRouter — routes outbound messages to the correct platform adapter.
 *
 * Target formats:
 *   "origin"           → reply via the adapter/chatId that originated the request
 *   "platform:chatId"  → look up the adapter by platform name and send to chatId
 */

import type { BaseAdapter, SendResult } from "./adapter.js";

export type AdapterLookup = (platform: string) => BaseAdapter | undefined;

export class DeliveryRouter {
  private readonly getAdapter: AdapterLookup;

  constructor(getAdapter: AdapterLookup) {
    this.getAdapter = getAdapter;
  }

  /**
   * Deliver a message to the specified target.
   *
   * @param target       "origin" or "platform:chatId"
   * @param content      The text content to send
   * @param originAdapter  The adapter the inbound message arrived on (needed for "origin")
   * @param originChatId   The chat the inbound message arrived in (needed for "origin")
   */
  async deliver(
    target: string,
    content: string,
    originAdapter?: BaseAdapter,
    originChatId?: string,
  ): Promise<SendResult> {
    if (target === "origin") {
      if (!originAdapter || !originChatId) {
        return {
          success: false,
          error: "Cannot deliver to 'origin': no origin adapter or chatId provided",
        };
      }
      return originAdapter.send(originChatId, content);
    }

    // Parse "platform:chatId"
    const colonIndex = target.indexOf(":");
    if (colonIndex === -1) {
      return {
        success: false,
        error: `Invalid target format: "${target}". Expected "origin" or "platform:chatId".`,
      };
    }

    const platform = target.slice(0, colonIndex);
    const chatId = target.slice(colonIndex + 1);

    const adapter = this.getAdapter(platform);
    if (!adapter) {
      return {
        success: false,
        error: `Platform "${platform}" is not connected`,
      };
    }

    return adapter.send(chatId, content);
  }
}
