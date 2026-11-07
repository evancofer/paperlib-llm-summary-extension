import { describe, expect, it, vi } from "vitest";

import { callAnthropic } from "../src/llm/anthropic";
import { HttpError, LLMRequest, providerMessage } from "../src/llm/http";
import { callOpenAI } from "../src/llm/openai";
import { buildSystemPrompt, buildUserMessage, DEFAULT_PROMPT } from "../src/llm/prompt";

const request: LLMRequest = {
  baseURL: "https://api.example.com/v1/",
  model: "m",
  apiKey: "secret",
  system: "sys",
  user: "usr",
  maxOutputTokens: 100,
  timeoutMs: 5000,
};

describe("prompt", () => {
  it("adds to the system prompt rather than replacing it", () => {
    const system = buildSystemPrompt("Chinese");
    expect(system).toContain("do not invent results");
    expect(system).toContain("Format the answer in Markdown");
    expect(system).toContain("Write in Chinese.");
    expect(buildSystemPrompt("  ")).not.toContain("Write in");
  });

  it("builds the user message", () => {
    expect(buildUserMessage("Do it.", { title: "T", year: "2020", publication: "Nature" }, "text")).toBe(
      "Do it.\n\nPaper: T (2020, Nature)\n\ntext"
    );
    expect(buildUserMessage("Do it.", { title: "T" }, "x")).toBe("Do it.\n\nPaper: T\n\nx");
  });

  it("has the fixed default prompt", () => {
    expect(DEFAULT_PROMPT.startsWith("Summarize this paper")).toBe(true);
  });
});

describe("OpenAI-compatible client", () => {
  const ok = { choices: [{ message: { content: " Hi. " }, finish_reason: "stop" }] };

  it("sends the documented request and reads the reply", async () => {
    const post = vi.fn().mockResolvedValue(ok);
    expect(await callOpenAI(request, post)).toEqual({ text: "Hi.", cutOff: false });
    expect(post).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      {
        model: "m",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "usr" },
        ],
        max_tokens: 100,
      },
      { Authorization: "Bearer secret" },
      5000
    );
  });

  it("leaves out the auth header for a blank key", async () => {
    const post = vi.fn().mockResolvedValue(ok);
    await callOpenAI({ ...request, apiKey: "" }, post);
    expect(post.mock.calls[0][2]).toEqual({});
  });

  it("retries with max_completion_tokens when the model asks for it", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(400, "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead."))
      .mockResolvedValueOnce(ok);
    await callOpenAI(request, post);
    expect(post.mock.calls[1][1]).toMatchObject({ max_completion_tokens: 100 });
    expect(post.mock.calls[1][1]).not.toHaveProperty("max_tokens");
  });

  it("flags a reply stopped by the token limit", async () => {
    const post = vi.fn().mockResolvedValue({ choices: [{ message: { content: "Hi" }, finish_reason: "length" }] });
    expect((await callOpenAI(request, post)).cutOff).toBe(true);
  });

  it("fails on an empty reply", async () => {
    const post = vi.fn().mockResolvedValue({ choices: [{ message: { content: "" }, finish_reason: "length" }] });
    await expect(callOpenAI(request, post)).rejects.toThrow("no text (stop reason: length)");
  });
});

describe("Anthropic client", () => {
  const ok = { content: [{ type: "text", text: "Hi" }, { type: "thinking" }, { type: "text", text: " there" }], stop_reason: "end_turn" };

  it("sends the documented request and joins text blocks", async () => {
    const post = vi.fn().mockResolvedValue(ok);
    expect(await callAnthropic({ ...request, baseURL: "https://api.anthropic.com" }, post)).toEqual({ text: "Hi there", cutOff: false });
    expect(post).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      { model: "m", system: "sys", messages: [{ role: "user", content: "usr" }], max_tokens: 100 },
      { "x-api-key": "secret", "anthropic-version": "2023-06-01" },
      5000
    );
  });

  it("accepts a base URL that already ends in /v1, and a blank one", async () => {
    const post = vi.fn().mockResolvedValue(ok);
    await callAnthropic({ ...request, baseURL: "https://proxy.example/v1/" }, post);
    await callAnthropic({ ...request, baseURL: "" }, post);
    expect(post.mock.calls[0][0]).toBe("https://proxy.example/v1/messages");
    expect(post.mock.calls[1][0]).toBe("https://api.anthropic.com/v1/messages");
  });

  it("flags max_tokens as cut off", async () => {
    const post = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Hi" }], stop_reason: "max_tokens" });
    expect((await callAnthropic(request, post)).cutOff).toBe(true);
  });
});

describe("errors", () => {
  it.each([
    [401, "Bad API key"],
    [403, "Bad API key"],
    [404, "Model or URL not found"],
    [429, "Rate limit or quota exceeded"],
    [503, "Provider error"],
    [400, "Request rejected"],
  ])("explains HTTP %i with the provider's message", (status, text) => {
    expect(new HttpError(status, "details").message).toBe(`${text} (HTTP ${status}): details`);
  });

  it("reads OpenAI, Anthropic and text error bodies", () => {
    expect(providerMessage('{"error":{"message":"openai"}}')).toBe("openai");
    expect(providerMessage('{"type":"error","error":{"type":"x","message":"anthropic"}}')).toBe("anthropic");
    expect(providerMessage('{"error":"ollama"}')).toBe("ollama");
    expect(providerMessage("Bad Gateway\n")).toBe("Bad Gateway");
  });
});
