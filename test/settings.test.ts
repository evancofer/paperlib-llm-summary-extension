import { describe, expect, it, vi } from "vitest";

import { formatReport, mapLimit } from "../src/batch";
import { KEY_MASK, PreferenceStore, Secrets } from "../src/secrets";
import { afterProviderSwitch, defaultPreference, PROVIDER_DEFAULTS, readSettings } from "../src/settings";

const values = (patch: Record<string, unknown> = {}) => {
  const all: Record<string, unknown> = Object.fromEntries(
    Object.entries(defaultPreference).map(([k, v]) => [k, v.value])
  );
  return (key: string) => ({ ...all, ...patch })[key];
};

describe("readSettings", () => {
  it("reads the defaults", () => {
    expect(readSettings(values())).toMatchObject({
      provider: "claude-code",
      scope: "main+captions",
      maxInputTokens: 30000,
      maxOutputTokens: 400,
      position: "top",
      batchLimit: 20,
      timeoutMs: 120000,
    });
  });

  it.each(["0", "-1", "abc", "1.5", "", "5 pages"])("rejects the page count %j", (pageCount) => {
    expect(() => readSettings(values({ scope: "pages", pageCount }))).toThrow("Number of pages");
  });

  it("checks the page count for abstract+captions, which can fall back to it", () => {
    expect(() => readSettings(values({ scope: "abstract+captions", pageCount: "abc" }))).toThrow("Number of pages");
  });

  it("ignores a bad page count for scopes that don't use it", () => {
    expect(() => readSettings(values({ scope: "all", pageCount: "abc" }))).not.toThrow();
    expect(() => readSettings(values({ scope: "main", pageCount: "abc" }))).not.toThrow();
  });

  it("rejects bad limits, a blank model and a bad URL", () => {
    expect(() => readSettings(values({ batchLimit: "0" }))).toThrow("Batch limit");
    expect(() => readSettings(values({ model: " " }))).toThrow("Model");
    expect(() => readSettings(values({ provider: "openai", baseURL: "api.openai.com" }))).toThrow("Base URL");
    expect(() => readSettings(values({ provider: "anthropic", baseURL: "" }))).toThrow("Base URL");
  });

  it("needs no base URL for Claude Code", () => {
    expect(readSettings(values({ provider: "claude-code", baseURL: "" })).baseURL).toBe("");
  });

  it("has a description telling how to save every string setting", () => {
    for (const setting of Object.values(defaultPreference)) {
      if (setting.type === "string") expect(setting.description).toContain("Press Enter to save");
    }
  });
});

describe("afterProviderSwitch", () => {
  it("swaps default values", () => {
    expect(afterProviderSwitch("anthropic", PROVIDER_DEFAULTS.openai)).toEqual(PROVIDER_DEFAULTS.anthropic);
    expect(afterProviderSwitch("openai", PROVIDER_DEFAULTS.anthropic)).toEqual(PROVIDER_DEFAULTS.openai);
    expect(afterProviderSwitch("openai", PROVIDER_DEFAULTS["claude-code"])).toEqual(PROVIDER_DEFAULTS.openai);
    expect(afterProviderSwitch("claude-code", PROVIDER_DEFAULTS.openai)).toEqual(PROVIDER_DEFAULTS["claude-code"]);
  });

  it("keeps custom values and fills blanks", () => {
    expect(afterProviderSwitch("anthropic", { baseURL: "http://localhost:1234/v1", model: "" })).toEqual({
      baseURL: "http://localhost:1234/v1",
      model: PROVIDER_DEFAULTS.anthropic.model,
    });
  });
});

describe("Secrets", () => {
  function setup(field = "") {
    const keychain = new Map<string, string>();
    const settings: Record<string, unknown> = { apiKey: field };
    const store: PreferenceStore = {
      get: (_id, key) => settings[key],
      set: (_id, patch) => void Object.assign(settings, patch),
      getPassword: async (_id, key) => keychain.get(key) ?? null,
      // Like keytar, which refuses blank passwords.
      setPassword: async (_id, key, value) => {
        if (!value) throw new Error("Password is required.");
        keychain.set(key, value);
      },
    };
    const warn = vi.fn();
    return { keychain, settings, store, warn, secrets: new Secrets(store, "ext", warn) };
  }

  it("moves a key out of the settings at startup", async () => {
    const { secrets, keychain, settings } = setup("sk-1");
    await secrets.migrate("openai");
    expect(keychain.get("apiKey:openai")).toBe("sk-1");
    expect(settings.apiKey).toBe(KEY_MASK);
    expect(await secrets.getKey("openai")).toBe("sk-1");
  });

  it("keeps the mask from being saved as a key", async () => {
    const { secrets, keychain } = setup(KEY_MASK);
    await secrets.onFieldChanged("openai");
    await secrets.migrate("openai");
    expect(keychain.size).toBe(0);
  });

  it("deletes a key on a blank field, despite keytar refusing blanks", async () => {
    const { secrets, settings } = setup("sk-1");
    await secrets.onFieldChanged("openai");
    settings.apiKey = "";
    await secrets.onFieldChanged("openai");
    expect(await secrets.getKey("openai")).toBe("");
  });

  it("restores the blank state after a restart", async () => {
    const { secrets, settings } = setup("sk-1");
    await secrets.migrate("openai");
    settings.apiKey = "";
    await secrets.onFieldChanged("openai");
    await secrets.migrate("openai");
    expect(settings.apiKey).toBe("");
  });

  it("keeps a key per provider", async () => {
    const { secrets, settings } = setup("sk-openai");
    await secrets.onFieldChanged("openai");
    await secrets.showFor("anthropic");
    expect(settings.apiKey).toBe("");
    settings.apiKey = "sk-ant";
    await secrets.onFieldChanged("anthropic");
    await secrets.showFor("openai");
    expect(settings.apiKey).toBe(KEY_MASK);
    expect(await secrets.getKey("openai")).toBe("sk-openai");
    expect(await secrets.getKey("anthropic")).toBe("sk-ant");
  });

  it("leaves the key in place if the keychain didn't take it", async () => {
    const { store, settings, warn } = setup("sk-1");
    store.setPassword = async () => undefined; // Paperlib swallows keychain errors.
    await new Secrets(store, "ext", warn).migrate("openai");
    expect(settings.apiKey).toBe("sk-1");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).not.toContain("sk-1");
  });
});

describe("batch", () => {
  it("keeps order and respects the concurrency limit", async () => {
    let running = 0;
    let peak = 0;
    const result = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running--;
      return n * 2;
    });
    expect(result).toEqual([10, 2, 6, 4, 8]);
    expect(peak).toBe(2);
  });

  it("formats the report", () => {
    expect(
      formatReport(
        [
          { status: "summarized", cutOff: false },
          { status: "summarized", cutOff: true },
          { status: "summarized", cutOff: false },
          { status: "skipped", reason: "no PDF" },
          { status: "failed", reason: "Bad API key (HTTP 401)" },
        ],
        30000
      )
    ).toBe("3 summarized, 1 skipped (no PDF), 1 failed: Bad API key (HTTP 401), 1 cut off by Max output tokens");
  });

  it("reports a trimmed paper with its size and the limit", () => {
    expect(formatReport([{ status: "summarized", cutOff: false, trimmedFrom: 42000 }], 30000)).toBe(
      "1 summarized, 1 trimmed to fit Max input tokens (about 42,000 tokens, limit 30,000)"
    );
  });

  it("reports the largest of several trimmed papers", () => {
    const results = [
      { status: "summarized" as const, cutOff: false, trimmedFrom: 42000 },
      { status: "summarized" as const, cutOff: false, trimmedFrom: 90000 },
    ];
    expect(formatReport(results, 30000)).toContain("2 trimmed to fit Max input tokens (largest about 90,000 tokens");
  });
});
