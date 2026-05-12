import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { createTempDir } from "../../helpers/fixtures.js";
import { SessionStore } from "../../../src/core/session-store.js";
import { todosCommand } from "../../../src/cli/commands/todo-commands.js";
import type { CommandContext } from "../../../src/cli/commands/registry.js";

let tmpDir: { path: string; cleanup: () => void };
let store: SessionStore;
const SESSION_ID = "s1";

function makeCtx(sessionId: string | undefined): { ctx: CommandContext; output: string[] } {
  const output: string[] = [];
  const ctx: CommandContext = {
    config: {},
    sessionStore: store,
    sessionId,
    output: (line: string) => output.push(line),
  };
  return { ctx, output };
}

beforeEach(() => {
  tmpDir = createTempDir("todos-cmd-test-");
  store = new SessionStore(join(tmpDir.path, "test.db"));
  store.createSession({ id: SESSION_ID, model: "gpt-4", source: "cli" });
});

afterEach(() => {
  store.close();
  tmpDir.cleanup();
});

describe("/todos command", () => {
  it("shows empty state when no todos", async () => {
    const { ctx, output } = makeCtx(SESSION_ID);
    await todosCommand.handler("", ctx);
    expect(output.join("\n")).toMatch(/no todos/i);
  });

  it("renders todos when set", async () => {
    store.setTodos(SESSION_ID, [
      { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
      { content: "Deploy", status: "pending", activeForm: "Deploying" },
    ]);
    const { ctx, output } = makeCtx(SESSION_ID);
    await todosCommand.handler("", ctx);
    const joined = output.join("\n");
    expect(joined).toContain("Task List");
    expect(joined).toContain("Writing tests");
    expect(joined).toContain("Deploy");
  });

  it("warns when no session", async () => {
    const { ctx, output } = makeCtx(undefined);
    await todosCommand.handler("", ctx);
    expect(output.join("\n")).toMatch(/no active session/i);
  });

  it("has expected metadata", () => {
    expect(todosCommand.name).toBe("todos");
    expect(todosCommand.aliases).toContain("todo");
    expect(todosCommand.category).toBe("Session");
  });
});
