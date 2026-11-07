export interface LLMRequest {
  baseURL: string;
  model: string;
  apiKey: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface LLMResponse {
  text: string;
  /** The reply hit the output limit. */
  cutOff: boolean;
}

/** Sends JSON and resolves to the parsed body. Rejects with an `HttpError`. */
export type PostJson = (
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number
) => Promise<unknown>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly providerMessage: string
  ) {
    super(describeStatus(status, providerMessage));
    this.name = "HttpError";
  }
}

function describeStatus(status: number, providerMessage: string): string {
  let summary: string;
  if (status === 401 || status === 403) summary = "Bad API key";
  else if (status === 404) summary = "Model or URL not found";
  else if (status === 429) summary = "Rate limit or quota exceeded";
  else if (status >= 500) summary = "Provider error";
  else summary = "Request rejected";
  return `${summary} (HTTP ${status})${providerMessage ? `: ${providerMessage}` : ""}`;
}

/** Pulls the message out of an error body, which is OpenAI- or Anthropic-shaped JSON or text. */
export function providerMessage(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const error = parsed?.error ?? parsed;
    const message = typeof error === "string" ? error : error?.message;
    if (typeof message === "string") return message;
  } catch {
    // Not JSON: the text itself is the message.
  }
  return body.trim().slice(0, 300);
}

export function trimSlashes(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function requireText(text: string, reason: string | undefined): string {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (trimmed === "") {
    throw new Error(`The model returned no text${reason ? ` (stop reason: ${reason})` : ""}`);
  }
  return trimmed;
}
