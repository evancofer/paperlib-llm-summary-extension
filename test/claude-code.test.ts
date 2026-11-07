import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  callClaudeCode,
  claudeArgs,
  ClaudeRun,
  findClaude,
  parseClaudeOutput,
  runClaude,
} from "../src/llm/claude-code";
import { LLMRequest } from "../src/llm/http";

const request: LLMRequest = {
  baseURL: "",
  model: "claude-haiku-5-5",
  apiKey: "",
  system: "sys",
  user: "paper text",
  maxOutputTokens: 400,
  timeoutMs: 5000,
};
const output = (body: unknown, code = 0): ClaudeRun => ({
  code,
  stdout: JSON.stringify(body),
  stderr: "",
  timedOut: false,
});

describe("claudeArgs", () => {
  const args = claudeArgs(request);

  it("runs without tools, saved sessions or user settings", () => {
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
  });

  it("passes the model and system prompt, and keeps the paper off the command line", () => {
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("sys");
    expect(args).not.toContain("paper text");
  });
});

describe("findClaude", () => {
  it("prefers PATH", () => {
    const found = findClaude(["/a", "/b"].join(path.delimiter), "/home/me", (f) => f.startsWith("/b"));
    expect(found).toBe(path.join("/b", "claude"));
  });

  it("finds the usual install when PATH is bare, as in apps opened from the Dock", () => {
    const expected = path.join("/home/me", ".local", "bin", "claude");
    expect(findClaude("/usr/bin", "/home/me", (f) => f === expected)).toBe(expected);
  });

  it("returns undefined when it isn't installed", () => {
    expect(findClaude("/usr/bin", "/home/me", () => false)).toBeUndefined();
  });
});

describe("parseClaudeOutput", () => {
  it("reads the reply", () => {
    expect(parseClaudeOutput(output({ result: " Hi. ", stop_reason: "end_turn" }), 5000)).toEqual({
      text: "Hi.",
      cutOff: false,
    });
  });

  it("flags a reply stopped by the token limit", () => {
    expect(parseClaudeOutput(output({ result: "Hi", stop_reason: "max_tokens" }), 5000).cutOff).toBe(true);
  });

  it("reports Claude's own errors, such as not being signed in", () => {
    expect(() => parseClaudeOutput(output({ is_error: true, result: "Not logged in" }, 1), 5000)).toThrow(
      "Claude Code: Not logged in"
    );
  });

  it("reports output that isn't JSON", () => {
    const run = { code: 2, stdout: "", stderr: "boom\n", timedOut: false };
    expect(() => parseClaudeOutput(run, 5000)).toThrow("Claude Code failed (exit 2): boom");
  });

  it("reports a timeout", () => {
    expect(() => parseClaudeOutput({ ...output({}), timedOut: true }, 5000)).toThrow("No reply within 5 seconds");
  });

  it("fails on an empty reply", () => {
    expect(() => parseClaudeOutput(output({ result: "" }), 5000)).toThrow("no text");
  });
});

describe("callClaudeCode", () => {
  it("sends the paper on stdin", async () => {
    const run = vi.fn().mockResolvedValue(output({ result: "Done" }));
    await callClaudeCode(request, run, "/bin/claude");
    expect(run).toHaveBeenCalledWith("/bin/claude", claudeArgs(request), "paper text", 5000);
  });

  it("explains how to install it when it's missing", async () => {
    await expect(callClaudeCode(request, vi.fn(), "")).rejects.toThrow("Claude Code wasn't found");
  });
});

describe.skipIf(process.platform === "win32")("runClaude", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plsum-test-"));
  const script = (name: string, body: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("passes stdin through, and captures output and the exit code", async () => {
    const run = await runClaude(script("echo", 'cat; echo err >&2; exit 3'), [], "hello", 5000);
    expect(run).toEqual({ code: 3, stdout: "hello", stderr: "err\n", timedOut: false });
  });

  it("handles input bigger than a pipe buffer", async () => {
    const big = "x".repeat(2_000_000);
    expect((await runClaude(script("big", "cat"), [], big, 10000)).stdout.length).toBe(big.length);
  });

  it("hides API keys, so the plan is used and not the API", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.ANTHROPIC_AUTH_TOKEN = "token";
    const run = await runClaude(script("env", 'printf "%s|%s" "$ANTHROPIC_API_KEY" "$ANTHROPIC_AUTH_TOKEN"'), [], "", 5000);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    expect(run.stdout).toBe("|");
  });

  it("stops a run that goes past the timeout", async () => {
    const run = await runClaude(script("slow", "exec sleep 30"), [], "", 100);
    expect(run.timedOut).toBe(true);
  });

  it("rejects when the binary can't start", async () => {
    await expect(runClaude(path.join(dir, "missing"), [], "", 1000)).rejects.toThrow();
  });
});
