import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentContext,
  DeleteFileTool,
  EditFileTool,
  GlobTool,
  GrepTool,
  LocalEnvironment,
  MkdirTool,
  MoveCopyTool,
  type ToolRunContext,
} from "../index.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ello-fs-tools-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function withCtx<T>(fn: (ctx: ToolRunContext) => Promise<T>): Promise<T> {
  const env = new LocalEnvironment({ defaultPath: tempDir, allowedPaths: [tempDir] });
  await env.enter();
  try {
    return await fn({ deps: new AgentContext({ env }) });
  } finally {
    await env.exit();
  }
}

describe("EditFileTool", () => {
  it("creates a new file with empty oldString", async () => {
    await withCtx(async (ctx) => {
      const result = await new EditFileTool().call(ctx, {
        path: "new.py",
        oldString: "",
        newString: "hello",
      });

      expect(result.toLowerCase()).toContain("created");
    });

    await expect(readFile(path.join(tempDir, "new.py"), "utf8")).resolves.toBe("hello");
  });

  it("replaces a unique match", async () => {
    await writeFile(path.join(tempDir, "f.py"), "foo bar baz", "utf8");

    await withCtx(async (ctx) => {
      const result = await new EditFileTool().call(ctx, {
        path: "f.py",
        oldString: "bar",
        newString: "qux",
      });

      expect(result.toLowerCase()).toContain("edited");
    });

    await expect(readFile(path.join(tempDir, "f.py"), "utf8")).resolves.toBe("foo qux baz");
  });

  it("rejects ambiguous replacement unless replaceAll is set", async () => {
    await writeFile(path.join(tempDir, "f.py"), "aaa aaa", "utf8");

    await withCtx(async (ctx) => {
      const tool = new EditFileTool();
      await expect(
        tool.call(ctx, { path: "f.py", oldString: "aaa", newString: "bbb" }),
      ).resolves.toContain("2 times");

      await expect(
        tool.call(ctx, {
          path: "f.py",
          oldString: "aaa",
          newString: "bbb",
          replaceAll: true,
        }),
      ).resolves.toContain("edited");
    });

    await expect(readFile(path.join(tempDir, "f.py"), "utf8")).resolves.toBe("bbb bbb");
  });

  it("reports missing old string and missing file", async () => {
    await writeFile(path.join(tempDir, "f.py"), "hello world", "utf8");

    await withCtx(async (ctx) => {
      const tool = new EditFileTool();

      await expect(
        tool.call(ctx, { path: "f.py", oldString: "xyz", newString: "abc" }),
      ).resolves.toContain("not found");
      await expect(
        tool.call(ctx, { path: "missing.py", oldString: "foo", newString: "bar" }),
      ).resolves.toContain("not found");
    });
  });
});

describe("shell-backed filesystem tools", () => {
  it("creates and deletes directories/files", async () => {
    await withCtx(async (ctx) => {
      await expect(new MkdirTool().call(ctx, { path: "nested/dir" })).resolves.toContain(
        "Successfully",
      );
      await writeFile(path.join(tempDir, "nested/dir/file.txt"), "x", "utf8");
      await expect(
        new DeleteFileTool().call(ctx, { path: "nested/dir/file.txt" }),
      ).resolves.toContain("Successfully");
    });

    await expect(readFile(path.join(tempDir, "nested/dir/file.txt"), "utf8")).rejects.toThrow();
  });

  it("moves and copies files", async () => {
    await writeFile(path.join(tempDir, "source.txt"), "source", "utf8");

    await withCtx(async (ctx) => {
      const tool = new MoveCopyTool();

      await expect(
        tool.call(ctx, { source: "source.txt", destination: "copy.txt", copy: true }),
      ).resolves.toContain("Copied");
      await expect(
        tool.call(ctx, { source: "source.txt", destination: "moved.txt" }),
      ).resolves.toContain("Moved");
    });

    await expect(readFile(path.join(tempDir, "copy.txt"), "utf8")).resolves.toBe("source");
    await expect(readFile(path.join(tempDir, "moved.txt"), "utf8")).resolves.toBe("source");
  });

  it("finds files with glob", async () => {
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src/a.ts"), "a", "utf8");
    await writeFile(path.join(tempDir, "src/b.py"), "b", "utf8");

    await withCtx(async (ctx) => {
      const result = await new GlobTool().call(ctx, {
        root: ".",
        pattern: "./src/*.ts",
      });

      expect(result).toEqual(["./src/a.ts"]);
    });
  });

  it("searches text with grep", async () => {
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src/a.txt"), "alpha\nbeta\n", "utf8");
    await writeFile(path.join(tempDir, "src/b.txt"), "gamma\n", "utf8");

    await withCtx(async (ctx) => {
      const result = await new GrepTool().call(ctx, {
        pattern: "alpha",
        path: "src",
        include: "*.txt",
      });

      expect(result).toContain("a.txt");
      expect(result).toContain("alpha");
    });
  });
});
