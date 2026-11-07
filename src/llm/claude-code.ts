import { spawn } from "child_process";
import { accessSync, constants } from "fs";
import os from "os";
import path from "path";

import { LLMRequest, LLMResponse, requireText } from "./http";

export interface ClaudeRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type RunClaude = (
  binary: string,
  args: string[],
  input: string,
  timeoutMs: number
) => Promise<ClaudeRun>;

const NOT_FOUND =
  "Claude Code wasn't found. Install it from https://claude.com/claude-code and sign in by running `claude` once.";

/**
 * Paper text is untrusted, so it gets no tools. Sessions aren't saved, and the user's
 * settings, plugins and MCP servers stay out of it.
 */
export function claudeArgs(request: LLMRequest): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    request.model,
    "--system-prompt",
    request.system,
    "--tools",
    "",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
}

/** Finds the binary. Apps opened from the Dock don't get the shell's PATH, so that isn't enough. */
export function findClaude(
  pathVariable = process.env.PATH ?? "",
  home = os.homedir(),
  isExecutable = (file: string) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
): string | undefined {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  const folders = [
    ...pathVariable.split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  return folders
    .flatMap((folder) => names.map((name) => path.join(folder, name)))
    .find(isExecutable);
}

export const runClaude: RunClaude = (binary, args, input, timeoutMs) =>
  new Promise((resolve, reject) => {
    // Without this, a key in the environment would bill the API instead of the plan.
    const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...env } = process.env;
    const child = spawn(binary, args, { cwd: os.tmpdir(), env, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", () => undefined); // Reported through the exit code.
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(input);
  });

export function parseClaudeOutput(run: ClaudeRun, timeoutMs: number): LLMResponse {
  if (run.timedOut) {
    throw new Error(`No reply within ${timeoutMs / 1000} seconds`);
  }

  let reply: { result?: unknown; is_error?: unknown; stop_reason?: unknown };
  try {
    reply = JSON.parse(run.stdout);
  } catch {
    const detail = (run.stderr || run.stdout).trim().slice(0, 300);
    throw new Error(`Claude Code failed (exit ${run.code})${detail ? `: ${detail}` : ""}`);
  }

  const text = typeof reply.result === "string" ? reply.result : "";
  if (reply.is_error) {
    throw new Error(`Claude Code: ${text.trim().slice(0, 300) || "unknown error"}`);
  }
  const stopReason = typeof reply.stop_reason === "string" ? reply.stop_reason : undefined;
  return { text: requireText(text, stopReason), cutOff: stopReason === "max_tokens" };
}

/** Summarizes through the local Claude Code CLI, using the user's Claude login. */
export async function callClaudeCode(
  request: LLMRequest,
  run: RunClaude = runClaude,
  binary: string | undefined = findClaude()
): Promise<LLMResponse> {
  if (!binary) throw new Error(NOT_FOUND);
  return parseClaudeOutput(
    await run(binary, claudeArgs(request), request.user, request.timeoutMs),
    request.timeoutMs
  );
}
