import { describe, expect, it } from "vitest";

import {
  applySummary,
  hashBody,
  hasEditedSummary,
  NoteSettings,
  parseSections,
  plainTextToMarkdown,
  SummaryMeta,
} from "../src/note/markers";
import { renderNote, visibleText } from "./render";

const meta: SummaryMeta = {
  id: "abcd1234",
  model: "gpt-4o-mini",
  date: "2026-11-06",
  scope: "main+captions",
  pages: 12,
};
const meta2: SummaryMeta = { ...meta, id: "ffff0000", model: "claude-haiku-5-5" };
const settings: NoteSettings = { position: "top", onEdited: "keep-both", plainNoteMode: "convert" };
const body = "This paper asks a question.\n\nIt finds **42**.";
const body2 = "A newer summary.";

const write = (note: string, s: Partial<NoteSettings> = {}, b = body, m = meta) =>
  applySummary(note, b, m, { ...settings, ...s }).note;
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("applySummary", () => {
  it("writes an empty note as Markdown", () => {
    const note = write("");
    expect(note.startsWith("<md>\n## AI Summary <!-- plsum:start v=1 id=abcd1234 ")).toBe(true);
    expect(note).toContain(`hash=${hashBody(body)} -->\n\n${body}\n<!-- plsum:end id=abcd1234 -->`);
  });

  it("treats a whitespace-only note as empty", () => {
    expect(write("  \n")).toBe(write(""));
  });

  it("writes exactly one copy to a non-empty plain note (the official double-append bug)", () => {
    expect(count(write("my thoughts"), body)).toBe(1);
  });

  it("puts the summary right after the <md> line at the top", () => {
    const note = write("<md>\nmy **notes**");
    expect(note.startsWith("<md>\n## AI Summary ")).toBe(true);
    expect(note.endsWith("\n\nmy **notes**")).toBe(true);
  });

  it("puts the summary at the end at the bottom", () => {
    const note = write("<md>\nmy notes", { position: "bottom" });
    expect(note.startsWith("<md>\nmy notes\n\n## AI Summary ")).toBe(true);
    expect(note.endsWith("<!-- plsum:end id=abcd1234 -->")).toBe(true);
  });

  it("handles <md> with nothing after it", () => {
    expect(write("<md>")).toBe(write(""));
    expect(write("<md>\n", { position: "bottom" })).toBe(write(""));
  });

  it("replaces our unedited section and keeps user text around it in place", () => {
    const first = write("<md>\nabove", { position: "bottom" });
    const withBelow = `${first}\n\nbelow`;
    const result = applySummary(withBelow, body2, meta2, settings);
    expect(result).toMatchObject({ outcome: "written", replaced: 1, editedKept: 0 });
    expect(result.note).toContain("<md>\nabove\n\n## AI Summary");
    expect(result.note.endsWith("\n\nbelow")).toBe(true);
    expect(result.note).toContain(body2);
    expect(result.note).not.toContain("asks a question");
    expect(parseSections(result.note)).toHaveLength(1);
  });

  it("stays at one section over repeated runs", () => {
    let note = write("<md>\nmine");
    for (let i = 0; i < 5; i++) note = write(note, {}, `summary ${i}`);
    expect(parseSections(note)).toHaveLength(1);
    expect(note).toContain("summary 4");
    expect(note.endsWith("\n\nmine")).toBe(true);
  });

  it("collapses two unedited duplicates into one, keeping the first spot", () => {
    const a = write("", {}, "one", meta).replace("<md>\n", "");
    const b = write("", {}, "two", meta2).replace("<md>\n", "");
    const result = applySummary(`<md>\nintro\n\n${a}\n\nmiddle\n\n${b}\n\nend`, body2, meta, settings);
    expect(result.replaced).toBe(2);
    expect(parseSections(result.note)).toHaveLength(1);
    expect(result.note).toMatch(/^<md>\nintro\n\n## AI Summary .*\n\nA newer summary\.\n<!-- plsum:end id=abcd1234 -->\n\nmiddle\n\nend$/s);
  });

  describe("when the user edited our section", () => {
    const edited = write("<md>\nmine").replace("It finds **42**.", "It finds 43, I checked.");

    it("recognizes the edit", () => {
      expect(parseSections(edited)[0].edited).toBe(true);
      expect(hasEditedSummary(edited)).toBe(true);
    });

    it("keep-both: leaves it byte for byte and adds the new section", () => {
      const result = applySummary(edited, body2, meta2, settings);
      expect(result).toMatchObject({ outcome: "written", replaced: 0, editedKept: 1 });
      expect(result.note).toContain("It finds 43, I checked.");
      expect(result.note).toContain(body2);
      expect(parseSections(result.note)).toHaveLength(2);
      expect(result.note.endsWith(edited.slice("<md>\n".length))).toBe(true);
    });

    it("keep-both: a later run replaces only the new section", () => {
      const once = applySummary(edited, body2, meta2, settings).note;
      const twice = applySummary(once, "third", meta2, settings).note;
      expect(twice).toContain("It finds 43, I checked.");
      expect(twice).toContain("third");
      expect(twice).not.toContain(body2);
      expect(parseSections(twice)).toHaveLength(2);
    });

    it("skip: changes nothing and reports it", () => {
      expect(applySummary(edited, body2, meta2, { ...settings, onEdited: "skip" })).toEqual({
        note: edited,
        outcome: "skipped-edited",
        replaced: 0,
        editedKept: 1,
      });
    });

    it.each([
      ["removing the blank line", (n: string) => n.replace(" -->\n\n", " -->\n")],
      ["changing the heading", (n: string) => n.replace("## AI Summary", "## My Summary")],
      ["adding text after the start marker", (n: string) => n.replace("-->\n\n", "--> mine\n\n")],
      ["changing line endings", (n: string) => n.replace(/\n/g, "\r\n")],
    ])("treats %s as an edit", (_name, change) => {
      const note = change(write("<md>\nmine"));
      expect(parseSections(note)[0].edited).toBe(true);
      expect(applySummary(note, body2, meta2, settings).note).toContain("It finds **42**.");
    });
  });

  describe("broken markers are user text", () => {
    it.each([
      ["start with no end", "<md>\n## AI Summary <!-- plsum:start v=1 id=aaaa1111 hash=000000000000 -->\n\nmine"],
      ["end with no start", "<md>\nmine\n<!-- plsum:end id=aaaa1111 -->"],
      ["ids that differ", "<md>\n## AI Summary <!-- plsum:start v=1 id=aaaa1111 hash=000000000000 -->\n\nmine\n<!-- plsum:end id=bbbb2222 -->"],
      ["a start with no id", "<md>\n## AI Summary <!-- plsum:start v=1 hash=000000000000 -->\n\nmine\n<!-- plsum:end id=bbbb2222 -->"],
    ])("%s", (_name, note) => {
      expect(parseSections(note)).toEqual([]);
      const result = write(note, { position: "bottom" });
      expect(result.startsWith(note)).toBe(true);
      expect(parseSections(result)).toHaveLength(1);
    });
  });

  it.each([
    ["the official extension's", "<md>\n## AI Summary\n\nThis paper is about cats."],
    ["the official extension's, in a plain-derived note", "<md>\nold\n\n## AI Summary\n\nsummary"],
    ["a user's own", "<md>\n## AI Summary\n\nI wrote this <!-- with a comment -->."],
  ])("never touches %s unmarked AI Summary heading", (_name, note) => {
    const result = write(note);
    expect(result.endsWith(note.slice("<md>\n".length))).toBe(true);
  });

  it("leaves math in the user's Markdown text unchanged", () => {
    const math = "Energy: $E = mc^2$ and\n\n$$\\int_0^1 x\\,dx$$";
    expect(write(`<md>\n${math}`).endsWith(`\n\n${math}`)).toBe(true);
    const replaced = write(write(`<md>\n${math}`), {}, body2);
    expect(replaced.endsWith(`\n\n${math}`)).toBe(true);
  });

  it("is not confused by replacement patterns in the summary body", () => {
    const tricky = "costs $& and $' and $1";
    expect(write("<md>\nmine", {}, tricky)).toContain(tricky);
    expect(write(write("<md>\nmine"), {}, tricky)).toContain(tricky);
  });

  it("recognizes its own output for awkward model names", () => {
    for (const model of ["a--b", "x>y", "org/model:free", "with space", "50%"]) {
      const note = write("<md>\nmine", {}, body, { ...meta, model });
      expect(note).not.toMatch(/start .*--[^>].*-->/);
      expect(parseSections(note)).toEqual([expect.objectContaining({ edited: false })]);
    }
  });

  it("does not let a section's marker inside another section count twice", () => {
    const inner = write("", {}, "inner", meta2).replace("<md>\n", "");
    const outer = write("<md>", {}, `quoted:\n${inner}\nend`, meta);
    expect(parseSections(outer)).toHaveLength(1);
  });
});

describe("plain-text notes", () => {
  const plain = "Line one\nLine two\n\nAfter a gap";

  it("convert: makes the note Markdown and keeps its look", () => {
    const note = write(plain, { position: "bottom" });
    expect(note.startsWith("<md>\n")).toBe(true);
    expect(visibleText(note)).toContain(plain);
  });

  it("plain: keeps the note plain with visible markers", () => {
    const note = write(plain, { plainNoteMode: "plain" }, body2);
    expect(note.startsWith("<md>")).toBe(false);
    expect(note.startsWith(`[AI Summary · gpt-4o-mini · 2026-11-06 · id=abcd1234 · hash=${hashBody(body2)}]\n\n${body2}\n[end AI Summary id=abcd1234]`)).toBe(true);
    expect(note.endsWith(`\n\n${plain}`)).toBe(true);
    expect(parseSections(note)).toEqual([expect.objectContaining({ edited: false })]);
  });

  it("plain: replaces, detects edits and removes like Markdown sections", () => {
    const opts = { plainNoteMode: "plain" as const };
    const first = write(plain, opts);
    const second = write(first, opts, body2);
    expect(parseSections(second)).toHaveLength(1);
    expect(second).not.toContain("It finds");

    const edited = first.replace("**42**", "43");
    const third = write(edited, opts, body2);
    expect(third).toContain("It finds 43.");
    expect(parseSections(third)).toHaveLength(2);
  });

  it("switching to convert replaces an old plain section and keeps the user's text", () => {
    const before = write(plain, { plainNoteMode: "plain", position: "bottom" });
    const after = write(before, { plainNoteMode: "convert" }, body2);
    expect(after.startsWith("<md>\n")).toBe(true);
    expect(after).not.toContain("[AI Summary");
    expect(parseSections(after)).toHaveLength(1);
    expect(visibleText(after)).toContain(plain);
  });

  it.each([
    ["Markdown syntax", "# not a heading\n- not a list\n1. not numbered\n* star _under_ `code`"],
    ["HTML", "<b>bold?</b> a<b and <!-- comment -->"],
    ["links", "[text](http://example.com) ![img](x.png)"],
    ["backslashes", "C:\\path\\to and \\* and \\\\"],
    ["math", "costs $5 and $6, $x^2$, $$y$$"],
    ["entities", "AT&T &amp; &lt;"],
    ["indentation", "    four spaces is code\n\tand a tab"],
    ["setext underlines", "Title\n=====\nOther\n---"],
    ["quotes and tables", "> quote\n| a | b |\n|---|---|"],
    ["several blank lines", "one\n\n\n\ntwo"],
    ["Unicode", "α → β 中文 🎉"],
  ])("converted text renders as the original: %s", (_name, text) => {
    expect(visibleText(`<md>\n${plainTextToMarkdown(text)}`)).toBe(text.replace(/\t/g, "    "));
  });
});

describe("rendered output", () => {
  it("hides the markers in Paperlib's Markdown pipeline", () => {
    const html = renderNote(write("<md>\nmine"));
    expect(html).not.toContain("plsum");
    expect(html).toContain("<h2>AI Summary");
    expect(html).toContain("<strong>42</strong>");
    expect(html).toContain("mine");
  });

  it("adds no lines to the 10-line preview beyond heading, blank, body and end", () => {
    const short = write("<md>", {}, "One line.");
    expect(short.split("\n").length).toBe(5);
  });
});
