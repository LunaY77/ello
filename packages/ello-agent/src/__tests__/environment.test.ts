import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalEnvironment, LocalFileOperator, LocalShell } from "../index.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ello-ts-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("LocalFileOperator", () => {
  it("reads writes and lists files", async () => {
    const op = new LocalFileOperator(tempDir);

    await op.writeText("hello.txt", "world");

    await expect(op.readText("hello.txt")).resolves.toBe("world");
    await expect(op.listDir(".")).resolves.toContain("hello.txt");
  });

  it("rejects disallowed paths", async () => {
    const op = new LocalFileOperator(tempDir, [tempDir]);

    await expect(op.readText("/etc/passwd")).rejects.toThrow("Path not allowed");
  });
});

describe("LocalShell", () => {
  it("runs commands in default cwd", async () => {
    const shell = new LocalShell(tempDir);

    const result = await shell.run("pwd");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(tempDir);
  });

  it("returns timeout result", async () => {
    const shell = new LocalShell();

    const result = await shell.run("sleep 10", { timeout: 100 });

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("timeout");
  });
});

describe("LocalEnvironment", () => {
  it("manages lifecycle", async () => {
    const env = new LocalEnvironment({ defaultPath: tempDir });

    expect(env.entered).toBe(false);
    await env.enter();
    try {
      expect(env.entered).toBe(true);
      expect(env.fileOperator).not.toBeNull();
      expect(env.shell).not.toBeNull();
    } finally {
      await env.exit();
    }
    expect(env.entered).toBe(false);
  });

  it("raises before enter and on double enter", async () => {
    const env = new LocalEnvironment({ defaultPath: tempDir });

    expect(() => env.fileOperator).toThrow("not been entered");
    await env.enter();
    try {
      await expect(env.enter()).rejects.toThrow("already been entered");
    } finally {
      await env.exit();
    }
  });

  it("returns environment context instructions", async () => {
    const env = new LocalEnvironment({ defaultPath: tempDir });
    await env.enter();
    try {
      const instructions = await env.getContextInstructions();
      expect(instructions).toContain("<environment-context>");
      expect(instructions).toContain(tempDir);
    } finally {
      await env.exit();
    }
  });
});
