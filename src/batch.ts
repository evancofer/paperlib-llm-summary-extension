export type PaperResult =
  /** `trimmedFrom` is the estimated size of a paper too large for Max input tokens. */
  | { status: "summarized"; cutOff: boolean; trimmedFrom?: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/** Runs `task` over `items`, at most `limit` at a time, keeping their order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** "3 summarized, 1 skipped (no PDF), 1 failed: reason" */
export function formatReport(results: PaperResult[], maxInputTokens: number): string {
  const counts = (reasons: string[]) => {
    const grouped = new Map<string, number>();
    reasons.forEach((r) => grouped.set(r, (grouped.get(r) ?? 0) + 1));
    return [...grouped.entries()];
  };

  const parts: string[] = [];
  const done = results.filter((r) => r.status === "summarized");
  if (done.length > 0) {
    parts.push(`${done.length} summarized`);
  }
  for (const [reason, n] of counts(results.flatMap((r) => (r.status === "skipped" ? [r.reason] : [])))) {
    parts.push(`${n} skipped (${reason})`);
  }
  for (const [reason, n] of counts(results.flatMap((r) => (r.status === "failed" ? [r.reason] : [])))) {
    parts.push(`${n} failed: ${reason}`);
  }

  const trimmed = done.flatMap((r) => (r.status === "summarized" && r.trimmedFrom ? [r.trimmedFrom] : []));
  if (trimmed.length > 0) {
    const size = Math.max(...trimmed).toLocaleString("en-US");
    const limit = maxInputTokens.toLocaleString("en-US");
    const label = trimmed.length > 1 ? "largest about" : "about";
    parts.push(`${trimmed.length} trimmed to fit Max input tokens (${label} ${size} tokens, limit ${limit})`);
  }

  const cutOff = done.filter((r) => r.status === "summarized" && r.cutOff).length;
  if (cutOff > 0) {
    parts.push(`${cutOff} cut off by Max output tokens`);
  }
  return parts.join(", ");
}
