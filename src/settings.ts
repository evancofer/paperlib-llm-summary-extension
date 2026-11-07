import type { Scope } from "./extract/select";
import { DEFAULT_PROMPT } from "./llm/prompt";
import type { NoteSettings } from "./note/markers";

export type Provider = "claude-code" | "openai" | "anthropic";

const SAVE_HINT = "Press Enter to save.";

export const PROVIDER_DEFAULTS: Record<Provider, { baseURL: string; model: string }> = {
  "claude-code": { baseURL: "", model: "claude-haiku-5-5" },
  openai: { baseURL: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  anthropic: { baseURL: "https://api.anthropic.com", model: "claude-haiku-5-5" },
};

export const defaultPreference = {
  provider: {
    type: "options",
    name: "Provider",
    description: "Which API format to use. Base URL and model follow unless you've changed them.",
    options: {
      "claude-code": "Claude Code (uses your Claude login, no API key)",
      openai: "OpenAI-compatible (OpenAI, DeepSeek, OpenRouter, Gemini, Ollama, LM Studio)",
      anthropic: "Anthropic API",
    },
    value: "claude-code",
    order: 0,
  },
  baseURL: {
    type: "string",
    name: "Base URL",
    description: `Not used by Claude Code. OpenAI https://api.openai.com/v1 · DeepSeek https://api.deepseek.com · OpenRouter https://openrouter.ai/api/v1 · Gemini https://generativelanguage.googleapis.com/v1beta/openai · Ollama http://localhost:11434/v1 · LM Studio http://localhost:1234/v1 · Anthropic https://api.anthropic.com. ${SAVE_HINT}`,
    value: PROVIDER_DEFAULTS["claude-code"].baseURL,
    order: 1,
  },
  model: {
    type: "string",
    name: "Model",
    description: `The provider's model name. ${SAVE_HINT}`,
    value: PROVIDER_DEFAULTS["claude-code"].model,
    order: 2,
  },
  apiKey: {
    type: "string",
    name: "API key",
    description: `Not needed for Claude Code or local servers. Moved to your system keychain when saved, with one key kept per provider. Clear the field to delete it. ${SAVE_HINT}`,
    value: "",
    order: 3,
  },
  scope: {
    type: "options",
    name: "Text to send",
    description: "How much of the paper goes to the model.",
    options: {
      pages: "First N pages",
      main: "Main text only",
      "main+captions": "Main text + figure and table captions",
      "abstract+captions": "Abstract + captions",
      all: "Whole PDF",
    },
    value: "main+captions",
    order: 4,
  },
  pageCount: {
    type: "string",
    name: "Number of pages",
    description: `Used for "First N pages", and for "Abstract + captions" when a paper has no Abstract heading. ${SAVE_HINT}`,
    value: "5",
    order: 5,
  },
  stripRepeatedHeaders: {
    type: "boolean",
    name: "Remove page headers and footers",
    description: "Drops lines repeated at the top or bottom of most pages.",
    value: true,
    order: 7,
  },
  maxInputTokens: {
    type: "string",
    name: "Max input tokens",
    description: `Estimated as characters ÷ 4. Longer text is trimmed from the end, keeping captions if possible. ${SAVE_HINT}`,
    value: "30000",
    order: 8,
  },
  maxOutputTokens: {
    type: "string",
    name: "Max output tokens",
    description: `The longest reply allowed. Claude Code doesn't support this limit, so it's ignored there. ${SAVE_HINT}`,
    value: "400",
    order: 9,
  },
  prompt: {
    type: "string",
    name: "Prompt",
    description: `What to ask for. ${SAVE_HINT}`,
    value: DEFAULT_PROMPT,
    order: 10,
  },
  language: {
    type: "string",
    name: "Language",
    description: `For example English or Chinese. Leave blank to let the model decide. ${SAVE_HINT}`,
    value: "",
    order: 11,
  },
  position: {
    type: "options",
    name: "Summary position",
    description: "Where a new summary goes. Paperlib previews only the first 10 lines of a note.",
    options: { top: "Top of the note", bottom: "Bottom of the note" },
    value: "top",
    order: 12,
  },
  onEdited: {
    type: "options",
    name: "If you edited the last summary",
    description: "Your edited summary is never replaced. Choose whether to add a new one beside it.",
    options: { "keep-both": "Keep it and add the new summary", skip: "Skip the paper" },
    value: "keep-both",
    order: 13,
  },
  plainNoteMode: {
    type: "options",
    name: "Existing plain-text notes",
    description: "Convert keeps the note's look and hides the summary's markers. Plain leaves the note as plain text, with visible markers.",
    options: { convert: "Convert to Markdown", plain: "Keep as plain text" },
    value: "convert",
    order: 14,
  },
  batchLimit: {
    type: "string",
    name: "Batch limit",
    description: `The most papers allowed in one run. ${SAVE_HINT}`,
    value: "20",
    order: 15,
  },
  timeoutSec: {
    type: "string",
    name: "Timeout (seconds)",
    description: `For each request. ${SAVE_HINT}`,
    value: "120",
    order: 16,
  },
};

export interface Settings extends NoteSettings {
  provider: Provider;
  baseURL: string;
  model: string;
  scope: Scope;
  pageCount: number;
  stripRepeatedHeaders: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  prompt: string;
  language: string;
  batchLimit: number;
  timeoutMs: number;
}

function positiveInt(value: unknown, name: string): number {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error(`${name} must be a positive whole number, not "${text}"`);
  }
  return Number(text);
}

function requiredText(value: unknown, name: string): string {
  const text = String(value ?? "").trim();
  if (text === "") throw new Error(`${name} can't be blank`);
  return text;
}

/** Reads and validates the settings. Throws a message fit to show the user. */
export function readSettings(get: (key: string) => unknown): Settings {
  const provider = get("provider") as Provider;
  const baseURL = provider === "claude-code" ? "" : requiredText(get("baseURL"), "Base URL");
  if (provider !== "claude-code" && !/^https?:\/\/\S+$/i.test(baseURL)) {
    throw new Error(`Base URL must start with http:// or https://, not "${baseURL}"`);
  }
  const scope = get("scope") as Scope;

  return {
    provider,
    baseURL,
    model: requiredText(get("model"), "Model"),
    scope,
    pageCount:
      scope === "pages" || scope === "abstract+captions"
        ? positiveInt(get("pageCount"), "Number of pages")
        : 0,
    stripRepeatedHeaders: get("stripRepeatedHeaders") !== false,
    maxInputTokens: positiveInt(get("maxInputTokens"), "Max input tokens"),
    maxOutputTokens: positiveInt(get("maxOutputTokens"), "Max output tokens"),
    prompt: requiredText(get("prompt"), "Prompt"),
    language: String(get("language") ?? ""),
    position: get("position") as Settings["position"],
    onEdited: get("onEdited") as Settings["onEdited"],
    plainNoteMode: get("plainNoteMode") as Settings["plainNoteMode"],
    batchLimit: positiveInt(get("batchLimit"), "Batch limit"),
    timeoutMs: positiveInt(get("timeoutSec"), "Timeout") * 1000,
  };
}

/**
 * The base URL and model to use after a provider switch. Custom values stay; defaults
 * and blanks follow, so that Anthropic requests don't go to OpenAI's URL.
 */
export function afterProviderSwitch(
  provider: Provider,
  current: { baseURL: string; model: string }
): { baseURL: string; model: string } {
  const defaults = Object.values(PROVIDER_DEFAULTS);
  const follow = (key: "baseURL" | "model") => {
    const value = current[key].trim();
    return value === "" || defaults.some((d) => d[key] === value)
      ? PROVIDER_DEFAULTS[provider][key]
      : current[key];
  };
  return { baseURL: follow("baseURL"), model: follow("model") };
}
