import { describe, it, expect } from "vitest";
import { PermissionModel } from "../../src/core/permissions.js";
import { ConfigSchema } from "../../src/core/config-schema.js";

describe("PermissionModel v4: deny-by-default mode", () => {
  it("allow-all mode is unchanged (default behavior)", () => {
    const pm = new PermissionModel(); // mode defaults to "allow-all"
    const result = pm.check("any_tool", {});
    expect(result.allowed).toBe(true);
  });

  it("deny-by-default + allowlisted tool passes", () => {
    const pm = new PermissionModel({
      mode: "deny-by-default",
      allowList: ["file_read", "file_write"],
    });
    const result = pm.check("file_read", {});
    expect(result.allowed).toBe(true);
  });

  it("deny-by-default + unlisted tool is denied", () => {
    const pm = new PermissionModel({
      mode: "deny-by-default",
      allowList: ["file_read"],
    });
    const result = pm.check("shell_exec", {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("shell_exec");
  });

  it("deny-by-default + empty allowList denies all tools", () => {
    const pm = new PermissionModel({
      mode: "deny-by-default",
      allowList: [],
    });
    const result = pm.check("file_read", {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("permissionMode is configurable via ConfigSchema", () => {
    const config = ConfigSchema.parse({
      permissionMode: "deny-by-default",
    });
    expect(config.permissionMode).toBe("deny-by-default");

    const defaultConfig = ConfigSchema.parse({});
    expect(defaultConfig.permissionMode).toBe("allow-all");
  });
});
