import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../helpers/fixtures.js";
import {
  loadGatewayConfig,
  getEnabledPlatforms,
} from "../../src/gateway/config.js";

describe("Gateway Config", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = createTempDir("gateway-cfg-");
    // Clear env overrides between tests
    delete process.env.PURRFECT_TELEGRAM_TOKEN;
    delete process.env.PURRFECT_DISCORD_TOKEN;
    delete process.env.PURRFECT_SLACK_APP_TOKEN;
    delete process.env.PURRFECT_SLACK_BOT_TOKEN;
    delete process.env.PURRFECT_LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.PURRFECT_LINE_CHANNEL_SECRET;
    delete process.env.PURRFECT_WEBHOOK_PORT;
    delete process.env.PURRFECT_WEBHOOK_AUTH_TOKEN;
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("valid YAML is parsed and validated correctly", () => {
    const yaml = `
platforms:
  telegram:
    token: "tg-token-123"
    homeChannel: "mychan"
  discord:
    token: "dc-token-456"
sessionPolicy:
  mode: daily
  idleMinutes: 60
  dailyResetHour: 5
groupSessionsPerUser: false
`;
    writeFileSync(join(tmp.path, "gateway.yaml"), yaml);
    const config = loadGatewayConfig(tmp.path);
    expect(config.platforms.telegram?.token).toBe("tg-token-123");
    expect(config.platforms.telegram?.homeChannel).toBe("mychan");
    expect(config.platforms.discord?.token).toBe("dc-token-456");
    expect(config.sessionPolicy.mode).toBe("daily");
    expect(config.sessionPolicy.idleMinutes).toBe(60);
    expect(config.sessionPolicy.dailyResetHour).toBe(5);
    expect(config.groupSessionsPerUser).toBe(false);
  });

  it("env var overrides YAML values", () => {
    const yaml = `
platforms:
  telegram:
    token: "yaml-token"
sessionPolicy:
  mode: none
`;
    writeFileSync(join(tmp.path, "gateway.yaml"), yaml);
    process.env.PURRFECT_TELEGRAM_TOKEN = "env-token-override";
    const config = loadGatewayConfig(tmp.path);
    expect(config.platforms.telegram?.token).toBe("env-token-override");
  });

  it("missing config file throws a descriptive error", () => {
    expect(() => loadGatewayConfig(tmp.path)).toThrow(/gateway\.yaml/);
  });

  it("platform with missing required token fails validation", () => {
    const yaml = `
platforms:
  telegram:
    homeChannel: "mychan"
sessionPolicy:
  mode: none
`;
    writeFileSync(join(tmp.path, "gateway.yaml"), yaml);
    expect(() => loadGatewayConfig(tmp.path)).toThrow();
  });

  it("getEnabledPlatforms returns only platforms with tokens set", () => {
    const yaml = `
platforms:
  telegram:
    token: "tg-token"
  discord:
    token: "dc-token"
  slack:
    appToken: "slack-app"
    botToken: "slack-bot"
sessionPolicy:
  mode: both
`;
    writeFileSync(join(tmp.path, "gateway.yaml"), yaml);
    const config = loadGatewayConfig(tmp.path);
    const enabled = getEnabledPlatforms(config);
    expect(enabled).toContain("telegram");
    expect(enabled).toContain("discord");
    expect(enabled).toContain("slack");
    expect(enabled).not.toContain("line");
    expect(enabled).not.toContain("webhook");
  });
});
