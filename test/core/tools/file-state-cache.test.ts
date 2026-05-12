import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../../helpers/fixtures.js";
import { FileStateCache } from "../../../src/core/tools/file-state-cache.js";
import { createFileReadTool } from "../../../src/core/tools/file-read.js";
import { createFileWriteTool } from "../../../src/core/tools/file-write.js";
import { createFileEditTool } from "../../../src/core/tools/file-edit.js";

/* ------------------------------------------------------------------ */
/*  FileStateCache unit tests                                          */
/* ------------------------------------------------------------------ */
describe("FileStateCache", () => {
  let cache: FileStateCache;

  beforeEach(() => {
    cache = new FileStateCache();
  });

  it("returns false for unrecorded paths", () => {
    expect(cache.hasBeenRead("/some/file.txt")).toBe(false);
    expect(cache.getEntry("/some/file.txt")).toBeUndefined();
  });

  it("records and retrieves file state", () => {
    cache.recordRead("/tmp/test.txt", 1000, "hello");
    expect(cache.hasBeenRead("/tmp/test.txt")).toBe(true);
    const entry = cache.getEntry("/tmp/test.txt");
    expect(entry).toBeDefined();
    expect(entry!.mtimeMs).toBe(1000);
    expect(entry!.contentHash).toHaveLength(64); // sha256 hex
  });

  it("overwrites entry on second recordRead", () => {
    cache.recordRead("/tmp/test.txt", 1000, "v1");
    cache.recordRead("/tmp/test.txt", 2000, "v2");
    const entry = cache.getEntry("/tmp/test.txt");
    expect(entry!.mtimeMs).toBe(2000);
  });

  it("normalizes paths with relative segments", () => {
    cache.recordRead("/foo/../bar/file.txt", 1000, "x");
    expect(cache.hasBeenRead("/bar/file.txt")).toBe(true);
  });

  it("clear removes all entries", () => {
    cache.recordRead("/a.txt", 1, "a");
    cache.recordRead("/b.txt", 2, "b");
    cache.clear();
    expect(cache.hasBeenRead("/a.txt")).toBe(false);
    expect(cache.hasBeenRead("/b.txt")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  file_write — new file creation only                                */
/* ------------------------------------------------------------------ */
describe("file_write (new file creation only)", () => {
  let tmp: { path: string; cleanup: () => void };
  let cache: FileStateCache;
  let readTool: ReturnType<typeof createFileReadTool>;
  let writeTool: ReturnType<typeof createFileWriteTool>;

  beforeEach(() => {
    tmp = createTempDir();
    cache = new FileStateCache();
    readTool = createFileReadTool(cache);
    writeTool = createFileWriteTool(cache);
  });
  afterEach(() => tmp.cleanup());

  it("allows writing a new file", async () => {
    const filePath = join(tmp.path, "new-file.txt");
    const result = JSON.parse(await writeTool.handler({ path: filePath, content: "hello" }));
    expect(result.success).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("hello");
  });

  it("allows creating new file in nested directories", async () => {
    const filePath = join(tmp.path, "a", "b", "c", "deep.txt");
    const result = JSON.parse(await writeTool.handler({ path: filePath, content: "deep" }));
    expect(result.success).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("deep");
  });

  it("rejects writing to an existing file", async () => {
    const filePath = join(tmp.path, "existing.txt");
    writeFileSync(filePath, "original");

    const result = JSON.parse(await writeTool.handler({ path: filePath, content: "overwrite" }));
    expect(result.error).toContain("already exists");
    expect(result.error).toContain("file_edit");
    // Original content preserved
    expect(readFileSync(filePath, "utf-8")).toBe("original");
  });

  it("rejects writing to an existing file even after reading it", async () => {
    const filePath = join(tmp.path, "read-then-write.txt");
    writeFileSync(filePath, "original");
    await readTool.handler({ path: filePath });

    const result = JSON.parse(await writeTool.handler({ path: filePath, content: "overwrite" }));
    expect(result.error).toContain("already exists");
  });

  it("records new file in cache after creation", async () => {
    const filePath = join(tmp.path, "cached.txt");
    await writeTool.handler({ path: filePath, content: "hello" });
    expect(cache.hasBeenRead(filePath)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  file_read state tracking                                           */
/* ------------------------------------------------------------------ */
describe("file_read with FileStateCache", () => {
  let tmp: { path: string; cleanup: () => void };
  let cache: FileStateCache;
  let readTool: ReturnType<typeof createFileReadTool>;

  beforeEach(() => {
    tmp = createTempDir();
    cache = new FileStateCache();
    readTool = createFileReadTool(cache);
  });
  afterEach(() => tmp.cleanup());

  it("records state in cache after successful read", async () => {
    const filePath = join(tmp.path, "tracked.txt");
    writeFileSync(filePath, "content");

    expect(cache.hasBeenRead(filePath)).toBe(false);
    await readTool.handler({ path: filePath });
    expect(cache.hasBeenRead(filePath)).toBe(true);
  });

  it("does not record in cache for non-existent file", async () => {
    const filePath = join(tmp.path, "ghost.txt");
    const result = JSON.parse(await readTool.handler({ path: filePath }));
    expect(result.error).toBeDefined();
    expect(cache.hasBeenRead(filePath)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  file_edit — substring replacement                                  */
/* ------------------------------------------------------------------ */
describe("file_edit tool", () => {
  let tmp: { path: string; cleanup: () => void };
  let cache: FileStateCache;
  let readTool: ReturnType<typeof createFileReadTool>;
  let editTool: ReturnType<typeof createFileEditTool>;

  beforeEach(() => {
    tmp = createTempDir();
    cache = new FileStateCache();
    readTool = createFileReadTool(cache);
    editTool = createFileEditTool(cache);
  });
  afterEach(() => tmp.cleanup());

  it("replaces a unique substring after reading", async () => {
    const filePath = join(tmp.path, "edit.txt");
    writeFileSync(filePath, "hello world");
    await readTool.handler({ path: filePath });

    const result = JSON.parse(
      await editTool.handler({ path: filePath, old_string: "hello", new_string: "goodbye" }),
    );
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(1);
    expect(readFileSync(filePath, "utf-8")).toBe("goodbye world");
  });

  it("rejects edit without prior read", async () => {
    const filePath = join(tmp.path, "no-read.txt");
    writeFileSync(filePath, "hello");

    const result = JSON.parse(
      await editTool.handler({ path: filePath, old_string: "hello", new_string: "bye" }),
    );
    expect(result.error).toContain("must read this file");
  });

  it("rejects when old_string is not found", async () => {
    const filePath = join(tmp.path, "missing.txt");
    writeFileSync(filePath, "hello world");
    await readTool.handler({ path: filePath });

    const result = JSON.parse(
      await editTool.handler({ path: filePath, old_string: "xyz", new_string: "abc" }),
    );
    expect(result.error).toContain("not found");
  });

  it("rejects when old_string matches multiple times without replace_all", async () => {
    const filePath = join(tmp.path, "multi.txt");
    writeFileSync(filePath, "aaa bbb aaa");
    await readTool.handler({ path: filePath });

    const result = JSON.parse(
      await editTool.handler({ path: filePath, old_string: "aaa", new_string: "ccc" }),
    );
    expect(result.error).toContain("2 locations");
    expect(result.error).toContain("replace_all");
    // File should be unchanged
    expect(readFileSync(filePath, "utf-8")).toBe("aaa bbb aaa");
  });

  it("replaces all occurrences with replace_all: true", async () => {
    const filePath = join(tmp.path, "replace-all.txt");
    writeFileSync(filePath, "aaa bbb aaa ccc aaa");
    await readTool.handler({ path: filePath });

    const result = JSON.parse(
      await editTool.handler({
        path: filePath,
        old_string: "aaa",
        new_string: "zzz",
        replace_all: true,
      }),
    );
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(3);
    expect(readFileSync(filePath, "utf-8")).toBe("zzz bbb zzz ccc zzz");
  });

  it("rejects when old_string equals new_string", async () => {
    const filePath = join(tmp.path, "same.txt");
    writeFileSync(filePath, "hello");
    await readTool.handler({ path: filePath });

    const result = JSON.parse(
      await editTool.handler({ path: filePath, old_string: "hello", new_string: "hello" }),
    );
    expect(result.error).toContain("identical");
  });

  it("detects external modification between read and edit", async () => {
    const filePath = join(tmp.path, "ext-mod.txt");
    writeFileSync(filePath, "hello world");
    await readTool.handler({ path: filePath });

    // Simulate external modification
    const future = new Date(Date.now() + 5000);
    utimesSync(filePath, future, future);

    const result = JSON.parse(
      await editTool.handler({ path: filePath, old_string: "hello", new_string: "bye" }),
    );
    expect(result.error).toContain("modified since last read");
  });

  it("allows consecutive edits without re-reading", async () => {
    const filePath = join(tmp.path, "multi-edit.txt");
    writeFileSync(filePath, "aaa bbb ccc");
    await readTool.handler({ path: filePath });

    // First edit
    const r1 = JSON.parse(
      await editTool.handler({ path: filePath, old_string: "aaa", new_string: "xxx" }),
    );
    expect(r1.success).toBe(true);

    // Second edit — should work because first edit updated cache
    const r2 = JSON.parse(
      await editTool.handler({ path: filePath, old_string: "bbb", new_string: "yyy" }),
    );
    expect(r2.success).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("xxx yyy ccc");
  });

  it("handles multiline content correctly", async () => {
    const filePath = join(tmp.path, "multiline.txt");
    const original = "function foo() {\n  return 1;\n}\n";
    writeFileSync(filePath, original);
    await readTool.handler({ path: filePath });

    const result = JSON.parse(
      await editTool.handler({
        path: filePath,
        old_string: "  return 1;",
        new_string: "  return 42;",
      }),
    );
    expect(result.success).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("function foo() {\n  return 42;\n}\n");
  });
});
