export type Scope = "pages" | "main" | "main+captions" | "abstract+captions" | "all";

export interface PdfLine {
  text: string;
  x: number;
  /** Baseline height from the page bottom. */
  y: number;
  /** Font size. */
  size: number;
}

export interface PdfPage {
  number: number;
  width: number;
  height: number;
  lines: PdfLine[];
}

export interface Paragraph {
  text: string;
  page: number;
  size: number;
}

export interface SelectOptions {
  scope: Scope;
  pageCount: number;
  /** Exact pages to use, as chosen in the page picker. Overrides `scope`. */
  pageList?: number[];
  stripRepeatedHeaders: boolean;
  maxInputTokens: number;
}

export interface Cuts {
  /** Characters removed as reference sections, and the page the first one starts on. */
  referencesChars: number;
  referencesPage?: number;
  abstract: "heading" | "not-found";
  captions: number;
}

export interface Selection {
  text: string;
  scope: Scope;
  totalPages: number;
  pagesUsed: number;
  chars: number;
  tokens: number;
  truncated: boolean;
  /** Estimated size before any trimming. */
  fullTokens: number;
  cuts: Cuts;
  notes: string[];
}

const CHARS_PER_TOKEN = 4;
const MIN_CHARS = 500;
const MARGIN_FRACTION = 0.08;
// Below 50% because journals alternate left- and right-page headers, which then
// appear on half the pages at most, or fewer when appendix pages differ.
const REPEAT_FRACTION = 0.25;
const MIN_REPEATS = 3;
const MIN_PARAGRAPH_CHARS = 25;
const MAX_ABSTRACT_CHARS = 5000;
const CAPTIONS_HEADER = "=== Figure and table captions ===";
const TRUNCATED = "[Text truncated here to fit the input limit.]";

const REFERENCES_TITLE =
  /^(\d+\.?\s*)?((cited\s+)?references?(\s+cited|\s+and\s+notes|\s+list)?|notes\s+and\s+references|bibliography|literature\s+cited|cited\s+literature|works\s+cited)$/i;
const ABSTRACT_HEADING = /^(abstract|summary)$/i;
const ABSTRACT_INLINE = /^abstract\b\s*[.:—–-]\s*\S/i;
const SECTION_HEADING =
  /^(\d+(\.\d+)*\.?\s*)?(abstract|summary|introduction|background|results|discussion|conclusions?|(online\s+|star\s*★?\s*)?methods|materials?\s+(and|&)\s+methods|appendi(x|ces)(\s+\S+)?|acknowledge?ments?|data availability|code availability|supporting information|supplementary (information|materials?)|extended data|author contributions|competing interests|additional information)$/i;
const CAPTION =
  /^(supplementary\s+)?(fig(ure)?\.?|table|extended data fig(ure)?\.?)\s*S?\d+[a-z]?[.:\s|]/i;
const NUMBERED_HEADING = /^\d+(\.\d+)*\.?\s+[A-Z]/;

/** Headers that no repeat count is needed for, as they're the same text everywhere. */
const BOILERPLATE = [
  /^(bioRxiv|medRxiv) preprint\b/i,
  /\bwas not certified by peer review\b/i,
  /\bThe copyright holder for this preprint\b/i,
  /^(this version posted|preprint in perpetuity)\b/i,
  /\bmade available under a?\s*CC[- ]/i,
  /^Downloaded from\b/i,
];

function normalize(text: string): string {
  // Small caps often come out as "R EFERENCES".
  return text
    .replace(/\b([A-Z])\s+(?=[A-Z]{2,}\b)/g, "$1")
    .replace(/[:.]\s*$/, "")
    .trim();
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
const isReferencesTitle = (text: string) =>
  wordCount(text) <= 4 && REFERENCES_TITLE.test(normalize(text));
const isSectionHeading = (text: string) =>
  wordCount(text) <= 6 &&
  (SECTION_HEADING.test(normalize(text)) || isReferencesTitle(text));
/** True for a caption's first line, but not for prose such as "Figure 2 shows that…". */
export function isCaption(text: string): boolean {
  const label = text.match(CAPTION)?.[0];
  if (label === undefined) return false;
  return !(/\s$/.test(label) && /^[a-z]/.test(text.slice(label.length)));
}

function repeatKey(text: string): string {
  return text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Drops page furniture. Boilerplate always goes; repeats only when asked. */
export function stripPages(pages: PdfPage[], stripRepeated: boolean): PdfPage[] {
  const inMargin = (page: PdfPage, line: PdfLine) => {
    const fraction = line.y / page.height;
    return fraction < MARGIN_FRACTION || fraction > 1 - MARGIN_FRACTION;
  };

  const pageCounts = new Map<string, number>();
  for (const page of pages) {
    const keys = new Set(
      page.lines.filter((l) => inMargin(page, l)).map((l) => repeatKey(l.text))
    );
    keys.forEach((key) => pageCounts.set(key, (pageCounts.get(key) ?? 0) + 1));
  }
  const threshold = Math.max(MIN_REPEATS, pages.length * REPEAT_FRACTION);

  return pages.map((page) => ({
    ...page,
    lines: page.lines.filter((line) => {
      if (BOILERPLATE.some((pattern) => pattern.test(line.text))) return false;
      if (!stripRepeated || !inMargin(page, line)) return true;
      if (/^\d{1,4}$/.test(line.text.trim())) return false;
      return (pageCounts.get(repeatKey(line.text)) ?? 0) < threshold;
    }),
  }));
}

function joinLines(left: string, right: string): string {
  if (/[a-z]-$/.test(left) && /^[a-z]/.test(right)) {
    return left.slice(0, -1) + right;
  }
  return `${left} ${right}`;
}

/** Groups lines into paragraphs, then rejoins paragraphs split by a column or page end. */
export function toParagraphs(pages: PdfPage[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  for (const page of pages) {
    let previous: PdfLine | undefined;
    let current: Paragraph | undefined;

    for (const line of page.lines) {
      let split =
        current === undefined || isSectionHeading(line.text) || isCaption(line.text);
      if (previous && !split) {
        const gap = previous.y - line.y;
        const height = Math.max(previous.size, line.size) * 1.2;
        const sizeRatio = Math.max(previous.size, line.size) / Math.min(previous.size, line.size);
        split =
          gap <= 0 ||
          gap > height * 1.5 ||
          sizeRatio > 1.1 ||
          line.x - previous.x > line.size * 0.8 ||
          isSectionHeading(current!.text);
      }

      if (split) {
        current = { text: line.text, page: page.number, size: line.size };
        paragraphs.push(current);
      } else {
        current!.text = joinLines(current!.text, line.text);
      }
      previous = line;
    }
  }

  const merged: Paragraph[] = [];
  for (const paragraph of paragraphs) {
    const last = merged[merged.length - 1];
    const continues =
      last !== undefined &&
      paragraph.page - last.page <= 1 &&
      Math.abs(last.size - paragraph.size) < 0.5 &&
      !/[.?!:]["')\]]?$/.test(last.text) &&
      /^[a-z]/.test(paragraph.text) &&
      !isSectionHeading(last.text);
    if (continues) {
      last.text = joinLines(last.text, paragraph.text);
    } else {
      merged.push({ ...paragraph });
    }
  }
  return merged;
}

/** The font size most of the text is set in. */
export function bodySize(paragraphs: Paragraph[]): number {
  const weights = new Map<number, number>();
  for (const { size, text } of paragraphs) {
    const key = Math.round(size * 2) / 2;
    weights.set(key, (weights.get(key) ?? 0) + text.length);
  }
  return [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}

function isHeading(paragraph: Paragraph, body: number): boolean {
  const { text, size } = paragraph;
  if (text.length > 100 || wordCount(text) > 12 || /[.?!,;]$/.test(text)) return false;
  return (
    isSectionHeading(text) ||
    size >= body * 1.08 ||
    NUMBERED_HEADING.test(text) ||
    (text === text.toUpperCase() && /[A-Z]{4}/.test(text))
  );
}

/**
 * The paragraphs of each reference section: from its title to the next heading of any
 * kind. A stray "References" on a contents page therefore costs almost nothing, and an
 * early stop only leaves some references in.
 */
export function findReferenceSections(paragraphs: Paragraph[], body: number): Set<number> {
  const sections = new Set<number>();
  let inSection = false;
  paragraphs.forEach((paragraph, index) => {
    if (isReferencesTitle(paragraph.text)) inSection = true;
    else if (isHeading(paragraph, body)) inSection = false;
    if (inSection) sections.add(index);
  });
  return sections;
}

function findAbstract(paragraphs: Paragraph[], body: number): [number, number] | undefined {
  const untilHeading = (start: number, first: number): [number, number] => {
    let end = start;
    let chars = 0;
    for (let i = first; i < paragraphs.length; i++) {
      if (isHeading(paragraphs[i], body) || isCaption(paragraphs[i].text)) break;
      chars += paragraphs[i].text.length;
      if (chars > MAX_ABSTRACT_CHARS && i > first) break;
      end = i + 1;
    }
    return [start, end];
  };

  const heading = paragraphs.findIndex((p) => ABSTRACT_HEADING.test(normalize(p.text)));
  if (heading !== -1) {
    return untilHeading(heading + 1, heading + 1);
  }
  const inline = paragraphs.findIndex((p) => ABSTRACT_INLINE.test(p.text));
  return inline !== -1 ? untilHeading(inline, inline) : undefined;
}

function dedupeCaptions(paragraphs: Paragraph[]): string[] {
  const seen = new Set<string>();
  const captions: string[] = [];
  for (const { text } of paragraphs) {
    const key = text.replace(/\s+/g, " ").toLowerCase();
    if (isCaption(text) && !seen.has(key)) {
      seen.add(key);
      captions.push(text);
    }
  }
  return captions;
}

function trimEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const room = maxChars - TRUNCATED.length - 2;
  if (room <= 0) return "";
  const cut = text.slice(0, room);
  const space = cut.lastIndexOf(" ");
  return `${space > room * 0.9 ? cut.slice(0, space) : cut}\n\n${TRUNCATED}`;
}

/** Fits the input limit, trimming the main text first and captions only after that. */
function assemble(main: string, captions: string[], maxTokens: number) {
  const budget = maxTokens * CHARS_PER_TOKEN;
  const block = captions.length > 0 ? `${CAPTIONS_HEADER}\n\n${captions.join("\n\n")}` : "";
  const glue = main !== "" && block !== "" ? 2 : 0;
  const total = main.length + block.length + glue;
  if (total <= budget) {
    return { text: [main, block].filter(Boolean).join("\n\n"), truncated: false };
  }
  const kept = trimEnd(main, Math.max(0, budget - block.length - glue));
  const left = budget - kept.length - (kept !== "" ? 2 : 0);
  const text = [kept, trimEnd(block, left)].filter(Boolean).join("\n\n");
  return { text, truncated: true };
}

const estimateTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

/** Estimated tokens on each page, for showing the size of a selection before it's sent. */
export function pageTokens(pdfPages: PdfPage[], stripRepeatedHeaders: boolean): Record<number, number> {
  const chars: Record<number, number> = {};
  for (const { page, text } of toParagraphs(stripPages(pdfPages, stripRepeatedHeaders))) {
    chars[page] = (chars[page] ?? 0) + text.length;
  }
  return Object.fromEntries(Object.entries(chars).map(([page, n]) => [page, estimateTokens(n)]));
}

/** Chooses the text to send. Throws when there's too little to summarize. */
export function selectText(pdfPages: PdfPage[], options: SelectOptions): Selection {
  const { pageCount, pageList, stripRepeatedHeaders, maxInputTokens } = options;
  const scope: Scope = pageList ? "pages" : options.scope;

  const pages = stripPages(pdfPages, stripRepeatedHeaders);
  const paragraphs = toParagraphs(pages);
  const body = bodySize(paragraphs);
  const references = findReferenceSections(paragraphs, body);
  const abstract = findAbstract(paragraphs, body);
  const allCaptions = dedupeCaptions(paragraphs);
  const notes: string[] = [];

  const removed = paragraphs.filter((_, index) => references.has(index));
  const cuts: Cuts = {
    referencesChars: removed.reduce((n, p) => n + p.text.length, 0),
    referencesPage: removed[0]?.page,
    abstract: abstract ? "heading" : "not-found",
    captions: allCaptions.length,
  };

  const inPageLimit = (p: Paragraph) =>
    pageList ? pageList.includes(p.page) : p.page <= pageCount;
  const isMainText = (paragraph: Paragraph, index: number) => {
    if (references.has(index) || isCaption(paragraph.text)) return false;
    const inAbstract = abstract !== undefined && index >= abstract[0] && index < abstract[1];
    return (
      inAbstract ||
      paragraph.text.length >= MIN_PARAGRAPH_CHARS ||
      isHeading(paragraph, body)
    );
  };

  let chosen: Paragraph[];
  let captions: string[] = [];
  switch (scope) {
    case "pages":
      chosen = paragraphs.filter(inPageLimit);
      break;
    case "all":
      chosen = paragraphs;
      break;
    case "abstract+captions":
      chosen = abstract
        ? paragraphs.slice(...abstract)
        : paragraphs.filter((p) => inPageLimit(p) && !isCaption(p.text));
      captions = allCaptions;
      if (!abstract) notes.push(`No Abstract heading: using the first ${pageCount} pages.`);
      break;
    case "main+captions":
      chosen = paragraphs.filter(isMainText);
      captions = allCaptions;
      break;
    case "main":
      chosen = paragraphs.filter(isMainText);
      break;
  }

  if ((scope === "main" || scope === "main+captions") && references.size === 0) {
    notes.push("No References section title found: any references are included.");
  }

  const mainText = chosen.map((p) => p.text).join("\n\n");
  const { text, truncated } = assemble(mainText, captions, maxInputTokens);
  const fullChars = mainText.length + captions.reduce((n, c) => n + c.length + 2, 0);
  if (truncated) notes.push("Trimmed to fit the input limit.");

  if (text.length < MIN_CHARS) {
    throw new Error(
      paragraphs.reduce((n, p) => n + p.text.length, 0) < MIN_CHARS
        ? "No extractable text (scanned PDF?)"
        : `Too little text for scope "${scope}" (${text.length} characters). Try another scope.`
    );
  }

  return {
    text,
    scope,
    totalPages: pdfPages.length,
    pagesUsed:
      pageList
        ? pageList.length
        : scope === "pages"
        ? Math.min(pageCount, pdfPages.length)
        : new Set(chosen.map((p) => p.page)).size,
    chars: text.length,
    tokens: estimateTokens(text.length),
    truncated,
    fullTokens: estimateTokens(fullChars),
    cuts,
    notes,
  };
}
