/**
 * startGateway — loads config, creates adapters, wires handler + delivery,
 * registers send_message, and starts the runner.
 */

import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { loadGatewayConfig, getEnabledPlatforms, type GatewayConfig } from "../gateway/config.js";
import { GatewayRunner } from "../gateway/runner.js";
import { MessageHandler } from "../gateway/handler.js";
import { DeliveryRouter } from "../gateway/delivery.js";
import { createSendMessageTool } from "../core/tools/send-message.js";
import { SessionStore } from "../core/session-store.js";
import { HttpProvider } from "../core/provider.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { registerBuiltins } from "../core/tools/index.js";
import type { BaseAdapter } from "../gateway/adapter.js";
import { defaultConfigDir, loadConfig, loadConfigV2 } from "./config.js";
import { resolveApiKey } from "../core/secrets.js";
import { createGatewayPermissions } from "../core/permissions.js";
import { buildAgentContext } from "./runtime.js";
import { MemoryStore } from "../core/memory/store.js";
import { SkillRegistry } from "../core/skills/registry.js";
import { McpClient } from "../core/mcp/client.js";
import { PluginDiscovery } from "../core/plugins/discovery.js";
import { PluginLoader } from "../core/plugins/loader.js";
import { HookRegistry } from "../core/plugins/hooks.js";
import { CredentialPool } from "../core/credential-pool.js";
import { buildToolEnablementMap, isPluginDisabled } from "./toggles.js";

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

async function createAdapter(
  platform: string,
  config: GatewayConfig,
  configDir: string,
): Promise<BaseAdapter> {
  switch (platform) {
    case "webhook": {
      const { WebhookAdapter } = await import("../gateway/adapters/webhook.js");
      const { WebhookSubscriptionStore } = await import("../gateway/webhook-subscriptions.js");
      const subscriptions = new WebhookSubscriptionStore(join(configDir, "webhooks.json"));
      return new WebhookAdapter({ ...config.platforms.webhook!, subscriptions });
    }
    case "telegram": {
      const { TelegramAdapter } = await import("../gateway/adapters/telegram.js");
      return new TelegramAdapter(config.platforms.telegram!);
    }
    case "discord": {
      const { DiscordAdapter } = await import("../gateway/adapters/discord.js");
      return new DiscordAdapter(config.platforms.discord!);
    }
    case "slack": {
      const { SlackAdapter } = await import("../gateway/adapters/slack.js");
      return new SlackAdapter(config.platforms.slack!);
    }
    case "line": {
      const { LineAdapter } = await import("../gateway/adapters/line.js");
      return new LineAdapter(config.platforms.line!);
    }
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

// ---------------------------------------------------------------------------
// startGateway
// ---------------------------------------------------------------------------

export async function startGateway(configDir?: string): Promise<GatewayRunner> {
  const dir = configDir ?? defaultConfigDir();

  // 1. Load gateway config
  const gatewayConfig = loadGatewayConfig(dir);

  // 2. Get enabled platforms
  const platforms = getEnabledPlatforms(gatewayConfig);
  if (platforms.length === 0) {
    throw new Error("No platforms enabled in gateway config. Configure at least one platform.");
  }

  // 3. Create runner and adapters
  const runner = new GatewayRunner(gatewayConfig);

  for (const platform of platforms) {
    const adapter = await createAdapter(platform, gatewayConfig, dir);
    runner.addAdapter(platform, adapter);
  }

  // 4. Load full CLI config for context, permissions, and extensions
  const fullConfig = loadConfigV2(dir);

  // 5. Create gateway permissions (deny-by-default)
  const permissions = createGatewayPermissions({
    allowedPaths: fullConfig.allowedPaths as string[] | undefined,
  });

  // 6. Create shared tool registry (built-ins registered after session store + provider)
  const toolRegistry = new ToolRegistry();

  // 7. Load MCP servers and plugins from config
  const mcpServers = (fullConfig as any).mcpServers ?? [];
  for (const server of mcpServers) {
    try {
      const client = new McpClient(toolRegistry, {
        command: server.command,
        args: server.args,
        env: server.env,
        enabledTools: server.enabledTools,
      });
      await client.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[gateway] MCP server "${server.name}" unavailable: ${msg}`);
    }
  }

  const hookRegistry = new HookRegistry();
  const pluginDirs: string[] = (fullConfig as any).pluginDirs ?? [];
  if (pluginDirs.length > 0) {
    try {
      const manifests = await PluginDiscovery.scan(pluginDirs);
      const loader = new PluginLoader();
      for (const manifest of manifests) {
        if (isPluginDisabled(manifest.name, dir)) {
          continue;
        }
        try {
          await loader.load(manifest, toolRegistry, hookRegistry);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[gateway] Plugin "${manifest.name}" failed to load: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[gateway] Plugin discovery failed: ${msg}`);
    }
  }

  // 8. Create delivery router
  const deliveryRouter = new DeliveryRouter((platform) => runner.getAdapter(platform));

  // 9. Register send_message tool
  const sendMessageTool = createSendMessageTool(deliveryRouter);
  toolRegistry.register(sendMessageTool);

  // 10. Create provider from CLI config
  const cliConfig = loadConfig(dir);
  const providerType = fullConfig.providerType as "openai" | "anthropic";
  const credentialPool = new CredentialPool({ path: join(dir, "credentials.json") });
  const provider = new HttpProvider({
    baseUrl: cliConfig.baseUrl,
    apiKey: resolveApiKey(cliConfig.apiKey, providerType) ?? "",
    model: cliConfig.model,
    credentialPool,
    providerType,
  });

  // 11. Create session store
  const dbPath = join(dir, "gateway-sessions.db");
  const sessionStore = new SessionStore(dbPath);

  // 11b. Resolve memoriesDir + memory backend (local or http per config)
  const memoriesDir = fullConfig.memoriesDir ?? join(dir, "memories");
  const { createMemoryBackend } = await import("../core/memory/backend.js");
  const memoryBackend = createMemoryBackend({
    dir: memoriesDir,
    config: (fullConfig as any).memory,
  });

  // 11c. Now register built-ins with sessionStore + provider + permissions
  registerBuiltins(toolRegistry, {
    sessionStore,
    provider,
    permissions,
    platform: "purrfect-editor",
    modelName: cliConfig.model,
    sandboxMode: fullConfig.sandbox,
    memoryBackend,
  });

  // Apply persisted tool-disabled overrides after every source has registered.
  toolRegistry.applyEnablement(buildToolEnablementMap(dir));

  // 12. Resolve skillsDir for handler context
  const skillsDir = fullConfig.skillsDir;

  // 12b. Optional pairing ACL — opt-in via gatewayConfig.pairing.enabled
  const pairingStore = gatewayConfig.pairing?.enabled
    ? new (await import("../gateway/acl.js")).PairingStore({
        path: gatewayConfig.pairing.storePath ?? join(dir, "pairing.json"),
      })
    : undefined;

  // 13. Create message handler with permissions, config, and ACL
  const handler = new MessageHandler({
    provider,
    sessionStore,
    toolRegistry,
    deliveryRouter,
    sessionPolicy: gatewayConfig.sessionPolicy,
    groupSessionsPerUser: gatewayConfig.groupSessionsPerUser,
    permissions,
    config: fullConfig,
    memoriesDir,
    skillsDir,
    gatewayConfig,
    pairingStore,
  });

  // 14. Wire adapter.onMessage → handler.handle
  for (const platform of platforms) {
    const adapter = runner.getAdapter(platform)!;
    adapter.onMessage((event) => {
      handler.handle(event, adapter).catch((err) => {
        console.error(`[gateway] Error handling message on ${platform}:`, err);
      });
    });
  }

  // 15. Start runner
  await runner.start();

  // 16. Write PID file for status/stop commands
  const pidFile = join(dir, "gateway.pid");
  writeFileSync(pidFile, String(process.pid), "utf-8");

  console.log(`Gateway started with platforms: ${platforms.join(", ")} (PID ${process.pid})`);

  // 17. Handle SIGTERM for graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down gateway...");
    try { unlinkSync(pidFile); } catch { /* ignore */ }
    // Fire user "stop" hooks before tearing down so configured hooks actually
    // run for gateway sessions (parity with REPL rl-close behavior).
    await handler.fireStopHooks();
    await runner.stop();
    sessionStore.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return runner;
}
