export type HookEvent =
  | "before_tool_call"
  | "after_tool_call"
  | "before_prompt"
  | "after_response"
  | "on_error";

export type HookHandler = (data: unknown) => void | Promise<void>;

/**
 * Central registry for lifecycle hooks. Plugins register handlers for
 * specific events. When an event fires, all handlers run in registration
 * order. Errors in individual hooks are caught and logged — they never
 * crash the firing loop.
 */
export class HookRegistry {
  private readonly hooks = new Map<string, HookHandler[]>();

  register(event: string, handler: HookHandler): void {
    let handlers = this.hooks.get(event);
    if (!handlers) {
      handlers = [];
      this.hooks.set(event, handlers);
    }
    handlers.push(handler);
  }

  async fire(event: string, data: unknown): Promise<void> {
    const handlers = this.hooks.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        await handler(data);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Hook error on "${event}": ${message}`);
      }
    }
  }
}
