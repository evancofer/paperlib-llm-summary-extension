import { existsSync, readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { extractPages } from "../src/extract/pdf";
import { selectText, SelectOptions } from "../src/extract/select";

// Run `npm run fixtures` to download these. Tests for missing PDFs are skipped.
const fixture = (name: string) => path.join(__dirname, "fixtures", name);
const options: SelectOptions = {
  scope: "main+captions",
  pageCount: 5,
  stripRepeatedHeaders: true,
  maxInputTokens: 1_000_000,
};
const load = async (name: string) => extractPages(new Uint8Array(readFileSync(fixture(name))));

describe.skipIf(!existsSync(fixture("arxiv-2col.pdf")))("two-column arXiv paper", () => {
  it("removes the references and reads the columns in order", async () => {
    const result = selectText(await load("arxiv-2col.pdf"), options);
    expect(result.totalPages).toBe(12);
    expect(result.cuts).toMatchObject({ referencesPage: 9, abstract: "heading" });
    expect(result.text).toContain("The details are in the appendix.");
    expect(result.cuts.captions).toBeGreaterThanOrEqual(20);
    expect(result.text).toContain("Deeper neural networks are more difficult to train.");
    expect(result.text).toContain("learning residual functions");
    expect(result.text).not.toContain("[1] Y. Bengio");
    expect(result.text).not.toContain("arXiv:1512.03385");
    expect(result.text).toContain("Figure 2. Residual learning: a building block.");
  });

  it("gets the abstract alone", async () => {
    const { text } = selectText(await load("arxiv-2col.pdf"), { ...options, scope: "abstract+captions" });
    expect(text).toContain("present a residual learning framework");
    expect(text).not.toContain("Is learning better networks as easy");
  });
});

describe.skipIf(!existsSync(fixture("plos.pdf")))("PLOS paper", () => {
  it("removes the references and page furniture", async () => {
    const result = selectText(await load("plos.pdf"), options);
    expect(result.cuts.abstract).toBe("heading");
    expect(result.cuts.referencesPage).toBeGreaterThanOrEqual(15);
    expect(result.text).toContain("Materials and methods");
    expect(result.text).not.toContain("PLOS ONE | https://doi.org");
    expect(result.text).not.toContain("Ollerton J, Winfree R");
    expect(result.text).toMatch(/Fig 1\. /);
  });
});

describe.skipIf(!existsSync(fixture("nature.pdf")))("paper with no section titles", () => {
  it("keeps all the text and says so", async () => {
    const result = selectText(await load("nature.pdf"), options);
    expect(result.cuts.referencesPage).toBeUndefined();
    expect(result.notes.join()).toContain("No References section title");
    expect(result.text).toContain("Full algorithm details");
    expect(result.text).not.toContain("Nature | Vol 596");
  });

  it("uses the first N pages when there's no Abstract heading", async () => {
    const { text, cuts } = selectText(await load("nature.pdf"), { ...options, scope: "abstract+captions" });
    expect(cuts.abstract).toBe("not-found");
    expect(text).toContain("Proteins are essential to life");
  });
});

describe.skipIf(!existsSync(fixture("biorxiv.pdf")))("bioRxiv preprint", () => {
  it("removes the preprint header", async () => {
    const result = selectText(await load("biorxiv.pdf"), { ...options, scope: "all" });
    expect(result.text).not.toMatch(/bioRxiv preprint doi/i);
    expect(result.text).not.toMatch(/not certified by peer review/i);
  });
});

it("rejects a file that isn't a PDF", async () => {
  await expect(extractPages(new TextEncoder().encode("not a pdf"))).rejects.toThrow();
});
