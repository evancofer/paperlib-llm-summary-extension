import { createHash } from "crypto";

const MD_PREFIX = "<md>";
const HEADING = "## AI Summary";
const SEPARATOR = "\n\n";

export interface SummaryMeta {
  id: string;
  model: string;
  date: string;
  scope: string;
  pages: number;
}

export interface NoteSettings {
  position: "top" | "bottom";
  onEdited: "keep-both" | "skip";
  plainNoteMode: "convert" | "plain";
}

export type ApplyOutcome = "written" | "skipped-edited";

export interface ApplyResult {
  note: string;
  outcome: ApplyOutcome;
  replaced: number;
  editedKept: number;
}

interface Section {
  start: number;
  end: number;
  edited: boolean;
}

export function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 12);
}

/** Keeps a value on one line and unable to close the comment or bracket holding it. */
function encodeValue(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\s/g, (c) => (c === " " ? "%20" : encodeURIComponent(c)))
    .replace(/--/g, "%2D%2D")
    .replace(/>/g, "%3E")
    .replace(/\]/g, "%5D");
}

function renderMarkdownSection(body: string, meta: SummaryMeta): string {
  const fields = [
    "v=1",
    `id=${encodeValue(meta.id)}`,
    `model=${encodeValue(meta.model)}`,
    `date=${encodeValue(meta.date)}`,
    `scope=${encodeValue(meta.scope)}`,
    `pages=${meta.pages}`,
    `hash=${hashBody(body)}`,
  ].join(" ");
  return `${HEADING} <!-- plsum:start ${fields} -->\n\n${body}\n<!-- plsum:end id=${encodeValue(meta.id)} -->`;
}

function renderPlainSection(body: string, meta: SummaryMeta): string {
  const id = encodeValue(meta.id);
  return `[AI Summary · ${encodeValue(meta.model)} · ${encodeValue(meta.date)} · id=${id} · hash=${hashBody(body)}]\n\n${body}\n[end AI Summary id=${id}]`;
}

const MD_START = /^(.*)<!-- plsum:start ([^\n]*?) -->(.*)$/gm;
const PLAIN_START = /^\[AI Summary · [^\n]*? · id=(\S+) · hash=([0-9a-f]{12})\]$/gm;

function field(fields: string, name: string): string | undefined {
  return fields.match(new RegExp(`(?:^| )${name}=(\\S+)`))?.[1];
}

/**
 * True when the text after a start marker is still exactly as written: the blank line,
 * the body with the recorded hash, and the newline before the end marker.
 */
function isUnedited(raw: string, hash: string | undefined): boolean {
  if (!hash || !raw.startsWith(SEPARATOR) || !raw.endsWith("\n")) {
    return false;
  }
  return hashBody(raw.slice(SEPARATOR.length, -1)) === hash;
}

/** Complete marker pairs, in note order. Anything else is the user's text. */
export function parseSections(note: string): Section[] {
  const candidates: Section[] = [];

  for (const match of note.matchAll(MD_START)) {
    const id = field(match[2], "id");
    if (!id) continue;
    const bodyStart = match.index! + match[0].length;
    const endMarker = `<!-- plsum:end id=${id} -->`;
    const endAt = note.indexOf(endMarker, bodyStart);
    if (endAt === -1) continue;
    const headingIntact = match[1] === `${HEADING} ` && match[3] === "";
    candidates.push({
      start: match.index!,
      end: endAt + endMarker.length,
      edited:
        !headingIntact ||
        !isUnedited(note.slice(bodyStart, endAt), field(match[2], "hash")),
    });
  }

  for (const match of note.matchAll(PLAIN_START)) {
    const bodyStart = match.index! + match[0].length;
    const endMarker = `[end AI Summary id=${match[1]}]`;
    const endAt = note.indexOf(endMarker, bodyStart);
    if (endAt === -1) continue;
    candidates.push({
      start: match.index!,
      end: endAt + endMarker.length,
      edited: !isUnedited(note.slice(bodyStart, endAt), match[2]),
    });
  }

  // A marker pair inside another section is that section's content, not a section.
  const sections: Section[] = [];
  for (const candidate of candidates.sort((a, b) => a.start - b.start)) {
    const last = sections[sections.length - 1];
    if (!last || candidate.start >= last.end) {
      sections.push(candidate);
    }
  }
  return sections;
}

/** Splits off the `<md>` line so that text can be inserted right after it. */
function splitMdHead(note: string): { head: string; rest: string } {
  const rest = note.slice(MD_PREFIX.length);
  return {
    head: `${MD_PREFIX}\n`,
    rest: rest.startsWith("\n") ? rest.slice(1) : rest,
  };
}

/** Removes a section along with the separator that was added when it was inserted. */
function cutSection(note: string, section: Section): string {
  let { start, end } = section;
  if (note.startsWith(SEPARATOR, end)) {
    end += SEPARATOR.length;
  } else if (note.slice(0, start).endsWith(SEPARATOR)) {
    start -= SEPARATOR.length;
  }
  return note.slice(0, start) + note.slice(end);
}

/** Text that holds the spot of the section being replaced while the note is processed. */
const SLOT = "\u0000plsum-slot\u0000";

function insertAt(note: string, section: string, position: "top" | "bottom"): string {
  const isMd = note.startsWith(MD_PREFIX);
  if (position === "bottom") {
    if (isMd && splitMdHead(note).rest === "") return `${MD_PREFIX}\n${section}`;
    return note === "" ? section : `${note}${SEPARATOR}${section}`;
  }
  if (!isMd) {
    return note === "" ? section : `${section}${SEPARATOR}${note}`;
  }
  const { head, rest } = splitMdHead(note);
  return rest === "" ? `${head}${section}` : `${head}${section}${SEPARATOR}${rest}`;
}

/**
 * Backslash-escapes plain text so it renders literally in Paperlib's Markdown view,
 * keeping its line breaks. Blank-line runs and leading spaces, which Markdown would
 * collapse, become non-breaking spaces.
 */
export function plainTextToMarkdown(text: string): string {
  const lines = text.split(/\r?\n/);
  let previousBlank = false;

  return lines
    .map((line, index) => {
      if (line.trim() === "") {
        const out = previousBlank ? "&nbsp;  " : "";
        previousBlank = true;
        return out;
      }
      previousBlank = false;

      const indent = line.match(/^[ \t]*/)![0];
      const indentOut = indent.replace(/\t/g, "    ").replace(/ /g, "&nbsp;");
      const escaped = line
        .slice(indent.length)
        .replace(/[ \t]+$/, "")
        .replace(/[\\`*_[\]<>&$~|]/g, "\\$&")
        .replace(/^([#+=-])/, "\\$1")
        .replace(/^(\d+)([.)])/, "$1\\$2");
      const next = lines[index + 1];
      const breaksLine = next !== undefined && next.trim() !== "";
      return `${indentOut}${escaped}${breaksLine ? "  " : ""}`;
    })
    .join("\n");
}

/**
 * Writes a summary into a note. Only complete, unedited sections of ours are ever
 * replaced or removed; every other character of the note is left alone.
 */
export function applySummary(
  note: string,
  newBody: string,
  meta: SummaryMeta,
  settings: NoteSettings
): ApplyResult {
  const sections = parseSections(note);
  const unedited = sections.filter((s) => !s.edited);
  const editedKept = sections.length - unedited.length;

  if (editedKept > 0 && settings.onEdited === "skip") {
    return { note, outcome: "skipped-edited", replaced: 0, editedKept };
  }

  const isEmpty = note.trim() === "";
  const isMd = note.startsWith(MD_PREFIX);
  const convert = !isEmpty && !isMd && settings.plainNoteMode === "convert";
  const useMarkdown = isEmpty || isMd || convert;
  const section = useMarkdown
    ? renderMarkdownSection(newBody, meta)
    : renderPlainSection(newBody, meta);

  if (isEmpty) {
    return {
      note: `${MD_PREFIX}\n${section}`,
      outcome: "written",
      replaced: 0,
      editedKept: 0,
    };
  }

  // Work from the end of the note so earlier offsets stay valid.
  let text = note;
  for (const old of unedited.slice(1).reverse()) {
    text = cutSection(text, old);
  }
  if (unedited.length > 0) {
    text = text.slice(0, unedited[0].start) + SLOT + text.slice(unedited[0].end);
  }

  if (convert) {
    text = `${MD_PREFIX}\n${text.split(SLOT).map(plainTextToMarkdown).join(SLOT)}`;
  }

  return {
    note:
      unedited.length > 0
        ? text.replace(SLOT, () => section)
        : insertAt(text, section, settings.position),
    outcome: "written",
    replaced: unedited.length,
    editedKept,
  };
}

/** True when `applySummary` with `onEdited: "skip"` would leave this note alone. */
export function hasEditedSummary(note: string): boolean {
  return parseSections(note).some((s) => s.edited);
}
