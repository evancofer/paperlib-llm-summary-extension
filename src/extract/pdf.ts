import "./runtime-shim";

import { readFileSync } from "fs";
import path from "path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";

import type { PdfLine, PdfPage } from "./select";

// Setting this makes pdf.js run its worker code in this thread, as there's no Worker
// and no module loader inside Paperlib's extension sandbox.
(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfWorker;

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

/**
 * Reads the predefined CMaps that CJK PDFs need from dist/cmaps. The default reader
 * uses fetch(), which can't read local files.
 */
class LocalCMapReader {
  async fetch({ name }: { name: string }) {
    const file = path.join(__dirname, "cmaps", `${path.basename(name)}.bcmap`);
    return { cMapData: new Uint8Array(readFileSync(file)), isCompressed: true };
  }
}

function itemSize(item: TextItem): number {
  return Math.hypot(item.transform[2], item.transform[3]) || item.height || 0;
}

function isHorizontal(item: TextItem): boolean {
  // Drops side-of-page stamps such as arXiv's, along with any rotated table text.
  return Math.abs(item.transform[1]) < 0.01 && item.transform[0] > 0;
}

/**
 * Groups text items into lines. Items stay in content-stream order, which is reading
 * order for generated PDFs, so two columns at the same height don't merge: the jump
 * back left, or a wide gap, starts a new line.
 */
export function groupIntoLines(items: TextItem[]): PdfLine[] {
  const lines: PdfLine[] = [];
  let current: (PdfLine & { right: number; sizes: Map<number, number> }) | undefined;

  const finish = () => {
    if (!current) return;
    const text = current.text.replace(/\s+/g, " ").trim();
    if (text !== "") {
      const size = [...current.sizes.entries()].sort((a, b) => b[1] - a[1])[0][0];
      lines.push({ text, x: current.x, y: current.y, size });
    }
    current = undefined;
  };

  for (const item of items) {
    if (!isHorizontal(item) || item.str === "") continue;
    const size = itemSize(item);
    const [x, y] = [item.transform[4], item.transform[5]];
    const right = x + item.width;

    if (item.str.trim() === "") {
      if (current) current.text += " ";
      continue;
    }

    const tolerance = Math.max(current?.size ?? 0, size) * 0.6;
    const sameLine =
      current !== undefined &&
      Math.abs(y - current.y) <= tolerance &&
      x >= current.right - size &&
      x - current.right <= size * 4;

    if (!sameLine) {
      finish();
      current = { text: "", x, y, size, right, sizes: new Map() };
    }
    const line = current!;
    if (line.text !== "" && !line.text.endsWith(" ") && x - line.right > size * 0.15) {
      line.text += " ";
    }
    line.text += item.str;
    line.right = Math.max(line.right, right);
    const rounded = Math.round(size * 10) / 10;
    line.sizes.set(rounded, (line.sizes.get(rounded) ?? 0) + item.str.length);
  }
  finish();
  return lines;
}

/** Parses a PDF into positioned lines. Throws if the file can't be opened. */
export async function extractPages(data: Uint8Array): Promise<PdfPage[]> {
  const task = pdfjs.getDocument({
    // A copy: the sandbox's Uint8Array is a different class from the host's Buffer.
    data: new Uint8Array(data),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    CMapReaderFactory: LocalCMapReader,
    cMapPacked: true,
  } as any);

  try {
    const document = await task.promise;
    const pages: PdfPage[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const { height, width } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push({
        number,
        height,
        width,
        lines: groupIntoLines(content.items as unknown as TextItem[]),
      });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
