// The same stack Paperlib uses to display notes (app/service/services/render-service.ts).
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import katex from "katex";
import MarkdownIt from "markdown-it";
import tm from "markdown-it-texmath";

const window = new JSDOM("").window;
const purify = createDOMPurify(window as any);
const md = new MarkdownIt({ html: true }).use(tm, {
  engine: katex,
  delimiters: "dollars",
});

/** Renders a stored note as the detail panel does; returns sanitized HTML. */
export function renderNote(note: string): string {
  const content = note.startsWith("<md>") ? note.slice(4) : note;
  return purify.sanitize(md.render(content));
}

/** The text a reader sees: line breaks kept, tags gone. */
export function visibleText(note: string): string {
  const element = window.document.createElement("div");
  element.innerHTML = renderNote(note).replace(/<br\s*\/?>\n?/g, "\n").replace(/<\/p>\s*<p>/g, "\n\n");
  // A line holding only non-breaking spaces looks blank.
  return (element.textContent ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/^ +$/gm, "")
    .replace(/\n+$/, "");
}
