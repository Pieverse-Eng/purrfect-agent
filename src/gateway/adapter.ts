/**
 * Base adapter types and abstract class for multi-platform messaging gateways.
 */

import type { ClarifyRequest } from "../core/tools/clarify.js";
import { renderClarifyRequest } from "../core/tools/clarify.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  retryable?: boolean;
}

export interface SessionSource {
  platform: string;
  chatId: string;
  userId: string;
  userName?: string;
  chatType: "dm" | "group" | "channel";
  threadId?: string;
}

export interface MessageEvent {
  text: string;
  messageType: "text" | "photo" | "voice" | "document";
  source: SessionSource;
  mediaUrls?: string[];
  replyToMessageId?: string;
  metadata?: {
    clarificationId?: string;
  };
}

export type MessageHandler = (event: MessageEvent) => void;

// ---------------------------------------------------------------------------
// Abstract base
// ---------------------------------------------------------------------------

export abstract class BaseAdapter {
  private messageHandler: MessageHandler | undefined;

  /** Connect to the platform (start polling / webhook). */
  abstract connect(): Promise<void>;

  /** Gracefully disconnect. */
  abstract disconnect(): Promise<void>;

  /** Send a text message to a chat and return the result. */
  abstract send(chatId: string, content: string): Promise<SendResult>;

  /**
   * Send a structured clarification request. Adapters can override this for
   * buttons/quick replies; the default is a plain numbered text prompt.
   */
  async sendClarification(
    chatId: string,
    request: ClarifyRequest,
  ): Promise<SendResult> {
    return this.send(chatId, renderClarifyRequest(request));
  }

  /** Send a typing / "chat action" indicator. */
  abstract sendTyping(chatId: string): Promise<void>;

  /** Register a handler that will be called for every inbound message. */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** Subclasses call this to dispatch an inbound message to the handler. */
  protected emitMessage(event: MessageEvent): void {
    this.messageHandler?.(event);
  }
}
