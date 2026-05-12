import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ── Zod Schema ──────────────────────────────────────────────────────────

const AccessControlSchema = z.object({
  allowedUsers: z.array(z.string()).default([]),
  allowedChats: z.array(z.string()).default([]),
});

const TelegramSchema = z.object({
  token: z.string(),
  homeChannel: z.string().optional(),
  accessControl: AccessControlSchema.optional(),
});

const DiscordSchema = z.object({
  token: z.string(),
  accessControl: AccessControlSchema.optional(),
});

const SlackSchema = z.object({
  appToken: z.string(),
  botToken: z.string(),
  accessControl: AccessControlSchema.optional(),
});

const LineSchema = z.object({
  channelAccessToken: z.string(),
  channelSecret: z.string(),
  webhookPort: z.number().optional(),
  accessControl: AccessControlSchema.optional(),
});

const WebhookSchema = z.object({
  port: z.number(),
  authToken: z.string().optional(),
  accessControl: AccessControlSchema.optional(),
});

const PlatformsSchema = z.object({
  telegram: TelegramSchema.optional(),
  discord: DiscordSchema.optional(),
  slack: SlackSchema.optional(),
  line: LineSchema.optional(),
  webhook: WebhookSchema.optional(),
});

const SessionPolicySchema = z.object({
  mode: z.enum(["daily", "idle", "both", "none"]),
  idleMinutes: z.number().default(1440),
  dailyResetHour: z.number().default(4),
});

const PairingSchema = z.object({
  /**
   * When true, every (platform, userId) pair must be approved by an
   * admin before its messages reach the agent. First message from an
   * unknown user is replied to with a one-time pairing code.
   */
  enabled: z.boolean().default(false),
  /**
   * Path to the pairing.json store. Defaults to <configDir>/pairing.json
   * when omitted at runtime (see startGateway).
   */
  storePath: z.string().optional(),
});

export const GatewayConfigSchema = z.object({
  platforms: PlatformsSchema.default({}),
  sessionPolicy: SessionPolicySchema.default({
    mode: "none",
    idleMinutes: 1440,
    dailyResetHour: 4,
  }),
  groupSessionsPerUser: z.boolean().default(true),
  pairing: PairingSchema.default({ enabled: false }),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

// ── Env-var override map ────────────────────────────────────────────────

function applyEnvOverrides(raw: Record<string, any>): void {
  const platforms = (raw.platforms ??= {});

  if (process.env.PURRFECT_TELEGRAM_TOKEN) {
    platforms.telegram ??= {};
    platforms.telegram.token = process.env.PURRFECT_TELEGRAM_TOKEN;
  }

  if (process.env.PURRFECT_DISCORD_TOKEN) {
    platforms.discord ??= {};
    platforms.discord.token = process.env.PURRFECT_DISCORD_TOKEN;
  }

  if (process.env.PURRFECT_SLACK_APP_TOKEN || process.env.PURRFECT_SLACK_BOT_TOKEN) {
    platforms.slack ??= {};
    if (process.env.PURRFECT_SLACK_APP_TOKEN) {
      platforms.slack.appToken = process.env.PURRFECT_SLACK_APP_TOKEN;
    }
    if (process.env.PURRFECT_SLACK_BOT_TOKEN) {
      platforms.slack.botToken = process.env.PURRFECT_SLACK_BOT_TOKEN;
    }
  }

  if (process.env.PURRFECT_LINE_CHANNEL_ACCESS_TOKEN || process.env.PURRFECT_LINE_CHANNEL_SECRET) {
    platforms.line ??= {};
    if (process.env.PURRFECT_LINE_CHANNEL_ACCESS_TOKEN) {
      platforms.line.channelAccessToken = process.env.PURRFECT_LINE_CHANNEL_ACCESS_TOKEN;
    }
    if (process.env.PURRFECT_LINE_CHANNEL_SECRET) {
      platforms.line.channelSecret = process.env.PURRFECT_LINE_CHANNEL_SECRET;
    }
  }

  if (process.env.PURRFECT_WEBHOOK_PORT) {
    platforms.webhook ??= {};
    platforms.webhook.port = Number(process.env.PURRFECT_WEBHOOK_PORT);
  }
  if (process.env.PURRFECT_WEBHOOK_AUTH_TOKEN) {
    platforms.webhook ??= {};
    platforms.webhook.authToken = process.env.PURRFECT_WEBHOOK_AUTH_TOKEN;
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Load and validate gateway configuration.
 * @param configDir  Directory containing `gateway.yaml`.
 *                   Defaults to `~/.purrfect`.
 */
export function loadGatewayConfig(
  configDir: string = join(homedir(), ".purrfect"),
): GatewayConfig {
  const filePath = join(configDir, "gateway.yaml");

  if (!existsSync(filePath)) {
    throw new Error(
      `Gateway config not found: ${filePath}. ` +
        `Create gateway.yaml in ${configDir} or set platform env vars.`,
    );
  }

  const raw: Record<string, any> = parseYaml(readFileSync(filePath, "utf-8")) ?? {};

  applyEnvOverrides(raw);

  return GatewayConfigSchema.parse(raw);
}

/**
 * Return the list of platform names that have their required tokens set.
 */
export function getEnabledPlatforms(config: GatewayConfig): string[] {
  const enabled: string[] = [];
  const p = config.platforms;

  if (p.telegram?.token) enabled.push("telegram");
  if (p.discord?.token) enabled.push("discord");
  if (p.slack?.appToken && p.slack?.botToken) enabled.push("slack");
  if (p.line?.channelAccessToken && p.line?.channelSecret) enabled.push("line");
  if (p.webhook?.port != null) enabled.push("webhook");

  return enabled;
}
