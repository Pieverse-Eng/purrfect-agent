/**
 * `purrfect webhook` CLI handler — manage outbound webhook subscriptions.
 */

import { join } from "node:path";
import { defaultConfigDir } from "./config.js";
import {
  WebhookSubscriptionStore,
  type WebhookSubscription,
} from "../gateway/webhook-subscriptions.js";

export type WebhookAction =
  | { kind: "list" }
  | {
      kind: "subscribe";
      url: string;
      event: string;
      secret?: string;
      chatId?: string;
      sessionId?: string;
      profile?: string;
      signatureHeader?: string;
      eventHeader?: string;
    }
  | { kind: "remove"; id: string };

const USAGE = `Usage:
  purrfect webhook subscribe <url> --event <name> [options]
  purrfect webhook list
  purrfect webhook remove <id>

Subscribe options:
  --secret <s>            Shared HMAC secret (auto-generated if omitted)
  --chat-id <id>          Chat to route inbound events to
  --session <id>          Session to route inbound events to
  --profile <name>        Profile to route inbound events to
  --signature-header <h>  Header carrying HMAC sig (default x-hub-signature-256)
  --event-header <h>      Header carrying event name (default x-event-name)`;

export function parseWebhookArgs(args: string[]): WebhookAction {
  const sub = args[0];
  switch (sub) {
    case undefined:
    case "list":
      return { kind: "list" };

    case "subscribe":
      return parseSubscribeArgs(args.slice(1));

    case "remove": {
      const id = args[1] ?? "";
      if (!id) throw new Error("Usage: purrfect webhook remove <id>");
      return { kind: "remove", id };
    }

    default:
      throw new Error(`Unknown webhook subcommand: ${sub}\n\n${USAGE}`);
  }
}

function parseSubscribeArgs(args: string[]): WebhookAction {
  if (args.length === 0) throw new Error(USAGE);
  const url = args[0];
  if (!url || url.startsWith("--")) throw new Error("subscribe: <url> is required");

  let event: string | undefined;
  let secret: string | undefined;
  let chatId: string | undefined;
  let sessionId: string | undefined;
  let profile: string | undefined;
  let signatureHeader: string | undefined;
  let eventHeader: string | undefined;

  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    switch (flag) {
      case "--event":
        event = required(flag, value);
        i++;
        break;
      case "--secret":
        secret = required(flag, value);
        i++;
        break;
      case "--chat-id":
        chatId = required(flag, value);
        i++;
        break;
      case "--session":
        sessionId = required(flag, value);
        i++;
        break;
      case "--profile":
        profile = required(flag, value);
        i++;
        break;
      case "--signature-header":
        signatureHeader = required(flag, value);
        i++;
        break;
      case "--event-header":
        eventHeader = required(flag, value);
        i++;
        break;
      default:
        throw new Error(`Unknown flag: ${flag}\n\n${USAGE}`);
    }
  }

  if (!event) throw new Error("--event <name> is required");

  return {
    kind: "subscribe",
    url,
    event,
    secret,
    chatId,
    sessionId,
    profile,
    signatureHeader,
    eventHeader,
  };
}

function required(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export interface WebhookCommandDeps {
  configDir?: string;
  output?: (text: string) => void;
}

export async function runWebhookCommand(
  action: WebhookAction,
  deps: WebhookCommandDeps = {},
): Promise<void> {
  const dir = deps.configDir ?? defaultConfigDir();
  const out = deps.output ?? ((t) => console.log(t));
  const store = new WebhookSubscriptionStore(join(dir, "webhooks.json"));

  switch (action.kind) {
    case "list": {
      const subs = store.list();
      if (subs.length === 0) {
        out("No webhook subscriptions configured.");
        return;
      }
      out(formatSubscriptions(subs));
      return;
    }

    case "subscribe": {
      const sub = store.add({
        url: action.url,
        event: action.event,
        secret: action.secret,
        chatId: action.chatId,
        sessionId: action.sessionId,
        profile: action.profile,
        signatureHeader: action.signatureHeader,
        eventHeader: action.eventHeader,
      });
      out(`Subscribed to ${sub.event} from ${sub.url}`);
      out(`  id:     ${sub.id}`);
      out(`  secret: ${sub.secret}`);
      out(`  deliver: POST /webhook/${sub.id} (header ${sub.signatureHeader ?? "x-hub-signature-256"} = HMAC-SHA256)`);
      return;
    }

    case "remove": {
      let target = store.get(action.id);
      if (!target) {
        const matches = store.findByIdPrefix(action.id);
        if (matches.length === 1) target = matches[0];
        else if (matches.length > 1) throw new Error(`Ambiguous id "${action.id}" — matches ${matches.length} subscriptions`);
      }
      if (!target) throw new Error(`Subscription not found: ${action.id}`);
      store.remove(target.id);
      out(`Removed subscription ${target.id} (${target.event} from ${target.url})`);
      return;
    }
  }
}

function formatSubscriptions(subs: WebhookSubscription[]): string {
  const rows = subs.map((s) => {
    const target = s.chatId ? `chat=${s.chatId}` : s.sessionId ? `session=${s.sessionId}` : s.profile ? `profile=${s.profile}` : "(default)";
    return `  ${s.id.slice(0, 8)}…  ${s.event.padEnd(20)}  ${s.url}  →  ${target}`;
  });
  return ["Webhook subscriptions:", "", ...rows, ""].join("\n");
}
