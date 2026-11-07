import { HttpError, LLMRequest, LLMResponse, PostJson, requireText, trimSlashes } from "./http";

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  }
  return "";
}

export async function callOpenAI(request: LLMRequest, post: PostJson): Promise<LLMResponse> {
  const url = `${trimSlashes(request.baseURL)}/chat/completions`;
  const headers: Record<string, string> = {};
  if (request.apiKey) headers.Authorization = `Bearer ${request.apiKey}`;

  const body = {
    model: request.model,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
  };

  let reply: any;
  try {
    reply = await post(url, { ...body, max_tokens: request.maxOutputTokens }, headers, request.timeoutMs);
  } catch (error) {
    // OpenAI's newer models reject max_tokens, and the model name is free text.
    const usesNewName =
      error instanceof HttpError &&
      error.status === 400 &&
      error.providerMessage.includes("max_completion_tokens");
    if (!usesNewName) throw error;
    reply = await post(url, { ...body, max_completion_tokens: request.maxOutputTokens }, headers, request.timeoutMs);
  }

  const choice = reply?.choices?.[0];
  return {
    text: requireText(messageText(choice?.message?.content), choice?.finish_reason),
    cutOff: choice?.finish_reason === "length",
  };
}
