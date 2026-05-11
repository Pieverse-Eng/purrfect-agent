import { describe, it, expect } from "vitest";
import {
  PermissionModel,
  createGatewayPermissions,
  GATEWAY_DEFAULT_ALLOW_LIST,
} from "../../src/core/permissions.js";

describe("PermissionModel: file path scoping", () => {
  it("file_read within allowedPaths passes", () => {
    const pm = new PermissionModel({
      allowedPaths: ["/home/user/projects"],
    });
    const result = pm.check("file_read", { path: "/home/user/projects/src/index.ts" });
    expect(result.allowed).toBe(true);
  });

  it("file_read outside allowedPaths is denied with path reason", () => {
    const pm = new PermissionModel({
      allowedPaths: ["/home/user/projects"],
    });
    const result = pm.check("file_read", { path: "/etc/passwd" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("file_read denied");
    expect(result.reason).toContain("/etc/passwd");
    expect(result.reason).toContain("outside allowed directories");
  });

  it("file_write outside allowedPaths is denied with path reason", () => {
    const pm = new PermissionModel({
      allowedPaths: ["/home/user/safe"],
    });
    const result = pm.check("file_write", { path: "/tmp/evil" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("file_write denied");
    expect(result.reason).toContain("outside allowed directories");
  });
});

describe("PermissionModel: gateway default permissions", () => {
  it("gateway defaults deny shell_exec with reason", () => {
    const pm = createGatewayPermissions();
    const result = pm.check("shell_exec", {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("shell_exec denied");
    expect(result.reason).toContain("gateway mode");
  });

  it("gateway defaults deny file_write with reason", () => {
    const pm = createGatewayPermissions();
    const result = pm.check("file_write", { path: "/home/user/test.txt" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("file_write denied");
    expect(result.reason).toContain("gateway mode");
  });

  it("gateway defaults allow file_read", () => {
    const pm = createGatewayPermissions();
    // file_read is in the allow list, and we need a valid path
    const result = pm.check("file_read", { path: process.cwd() + "/test.txt" });
    expect(result.allowed).toBe(true);
  });

  it("gateway defaults allow send_message", () => {
    const pm = createGatewayPermissions();
    const result = pm.check("send_message", {});
    expect(result.allowed).toBe(true);
  });

  it("GATEWAY_DEFAULT_ALLOW_LIST contains expected tools", () => {
    expect(GATEWAY_DEFAULT_ALLOW_LIST).toContain("file_read");
    expect(GATEWAY_DEFAULT_ALLOW_LIST).toContain("web_fetch");
    expect(GATEWAY_DEFAULT_ALLOW_LIST).toContain("send_message");
    expect(GATEWAY_DEFAULT_ALLOW_LIST).not.toContain("shell_exec");
    expect(GATEWAY_DEFAULT_ALLOW_LIST).not.toContain("file_write");
  });
});
