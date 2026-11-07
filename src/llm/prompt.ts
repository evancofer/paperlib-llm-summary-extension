export const DEFAULT_PROMPT =
  "Summarize this paper in 3–5 sentences: the question, the approach, the main findings (with key numbers if given), and the main limitation.";

export interface PaperInfo {
  title?: string;
  year?: string;
  publication?: string;
}

export function buildSystemPrompt(language: string): string {
  const parts = [
    "You summarize academic papers for a researcher's reference library. Be accurate; do not invent results. If the text is truncated, say what is missing.",
    "Format the answer in Markdown. Do not start with a title.",
  ];
  if (language.trim() !== "") parts.push(`Write in ${language.trim()}.`);
  return parts.join(" ");
}

export function buildUserMessage(prompt: string, paper: PaperInfo, text: string): string {
  const details = [paper.year, paper.publication].filter(Boolean).join(", ");
  const title = paper.title?.trim() || "Untitled";
  const label = details ? `${title} (${details})` : title;
  return `${prompt.trim()}\n\nPaper: ${label}\n\n${text}`;
}
