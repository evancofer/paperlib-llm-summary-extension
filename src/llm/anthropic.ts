import { LLMRequest, LLMResponse, PostJson, requireText, trimSlashes } from "./http";

const DEFAULT_BASE_URL = "https://api.anthropic.com";

export async function callAnthropic(request: LLMRequest, post: PostJson): Promise<LLMResponse> {
  const base = trimSlashes(request.baseURL || DEFAULT_BASE_URL).replace(/\/v1$/, "");
  const reply: any = await post(
    `${base}/v1/messages`,
    {
      model: request.model,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      max_tokens: request.maxOutputTokens,
    },
    { "x-api-key": request.apiKey, "anthropic-version": "2023-06-01" },
    request.timeoutMs
  );

  const blocks: any[] = Array.isArray(reply?.content) ? reply.content : [];
  const text = blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("");
  return {
    text: requireText(text, reply?.stop_reason),
    cutOff: reply?.stop_reason === "max_tokens",
  };
}
