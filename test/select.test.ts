import { describe, expect, it } from "vitest";

import {
  isCaption,
  pageTokens,
  PdfLine,
  PdfPage,
  SelectOptions,
  selectText,
  stripPages,
  toParagraphs,
} from "../src/extract/select";

const options: SelectOptions = {
  scope: "main",
  pageCount: 5,
  stripRepeatedHeaders: true,
  maxInputTokens: 30000,
};

const prose = (word: string) => `${word} results were measured carefully in this study. `.repeat(20).trim();

/** Lays blocks out top to bottom; each block is a paragraph, with a gap between them. */
function page(number: number, blocks: (string | { text: string; size: number })[]): PdfPage {
  const lines: PdfLine[] = [];
  let y = 700;
  for (const block of blocks) {
    const { text, size } = typeof block === "string" ? { text: block, size: 10 } : block;
    lines.push({ text, x: 50, y, size });
    y -= size * 3;
  }
  return { number, width: 612, height: 792, lines };
}

const entries = (name: string, count: number) =>
  Array.from({ length: count }, (_, i) => `[${i + 1}] ${name}, A. Nature Methods 12, 34–56 (${1980 + i}).`);

const paper = (blocks: (string | { text: string; size: number })[]) => [page(1, blocks)];

describe("stripPages", () => {
  const withFurniture = (n: number): PdfPage => ({
    number: n,
    width: 612,
    height: 792,
    lines: [
      { text: `Journal of Things ${n}`, x: 50, y: 760, size: 8 },
      { text: "Body text stays.", x: 50, y: 400, size: 10 },
      { text: String(n), x: 300, y: 30, size: 8 },
    ],
  });

  it("drops repeated headers and page numbers", () => {
    const stripped = stripPages([1, 2, 3, 4].map(withFurniture), true);
    expect(stripped.flatMap((p) => p.lines.map((l) => l.text))).toEqual(Array(4).fill("Body text stays."));
  });

  it("drops headers that alternate between left and right pages", () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({
      number: i + 1,
      width: 612,
      height: 792,
      lines: [
        { text: i % 3 === 0 ? `Nature | Vol 1 | ${i}` : "Other header text", x: 50, y: 770, size: 8 },
        { text: "Body.", x: 50, y: 400, size: 10 },
      ],
    }));
    expect(stripPages(pages, true).flatMap((p) => p.lines.map((l) => l.text))).toEqual(Array(12).fill("Body."));
  });

  it("keeps a line that appears on only two pages", () => {
    const pages = [1, 2, 3, 4, 5, 6].map((n) => ({
      ...withFurniture(n),
      lines: n <= 2 ? [{ text: "Note on two pages", x: 50, y: 770, size: 8 }] : [],
    }));
    expect(stripPages(pages, true)[0].lines).toHaveLength(1);
  });

  it("keeps them when asked", () => {
    expect(stripPages([1, 2].map(withFurniture), false)[0].lines).toHaveLength(3);
  });

  it("keeps a repeated line outside the margins", () => {
    expect(stripPages([1, 2, 3].map(withFurniture), true)[2].lines[0].text).toBe("Body text stays.");
  });

  it("drops preprint boilerplate even with repeat stripping off", () => {
    const lines = [
      "bioRxiv preprint doi: https://doi.org/10.1101/2020.03.22.002386; this version posted March 22, 2020.",
      "(which was not certified by peer review) is the author/funder.",
      "Downloaded from https://example.org on May 1",
      "Real text.",
    ].map((text, i) => ({ text, x: 50, y: 400 - i * 20, size: 10 }));
    const [result] = stripPages([{ number: 1, width: 612, height: 792, lines }], false);
    expect(result.lines.map((l) => l.text)).toEqual(["Real text."]);
  });
});

describe("toParagraphs", () => {
  const line = (text: string, y: number, x = 50, size = 10): PdfLine => ({ text, x, y, size });
  const pageOf = (lines: PdfLine[], number = 1): PdfPage => ({ number, width: 612, height: 792, lines });

  it("joins close lines and repairs hyphenation", () => {
    const [p] = toParagraphs([pageOf([line("We study learn-", 700), line("ing in mice.", 688)])]);
    expect(p.text).toBe("We study learning in mice.");
  });

  it("splits on a wide gap, a size change and a first-line indent", () => {
    const lines = [
      line("One.", 700),
      line("Two.", 660),
      line("Three.", 648, 50, 14),
      line("Four.", 628, 62),
    ];
    expect(toParagraphs([pageOf(lines)]).map((p) => p.text)).toEqual(["One.", "Two.", "Three.", "Four."]);
  });

  it("rejoins a sentence split across columns and pages", () => {
    const pages = [
      pageOf([line("The sentence runs past the", 100)]),
      pageOf([line("end of the page.", 700)], 2),
    ];
    expect(toParagraphs(pages).map((p) => p.text)).toEqual(["The sentence runs past the end of the page."]);
  });

  it("starts a new paragraph at a caption set tightly under another", () => {
    const lines = [line("Figure 1. First caption.", 700), line("Table 2. Second caption.", 690)];
    expect(toParagraphs([pageOf(lines)]).map((p) => p.text)).toEqual(lines.map((l) => l.text));
  });

  it("separates a section heading from text set tightly under it", () => {
    const lines = [line("References", 700), line("[1] A. Author. A paper.", 688)];
    expect(toParagraphs([pageOf(lines)]).map((p) => p.text)).toEqual(lines.map((l) => l.text));
  });
});

describe("isCaption", () => {
  it.each([
    "Figure 1. Overview",
    "Fig. 2: Results",
    "Fig 3 Results",
    "FIG. 4. Overview",
    "Fig. 1 | AlphaFold produces",
    "Table 2. Sizes",
    "Figure S1. More",
    "Supplementary Figure 3. Extra",
    "Supplementary Table 1: Extra",
    "Extended Data Fig. 1 | Accuracy",
    "Figure 1a. Panel",
  ])("accepts %s", (text) => expect(isCaption(text)).toBe(true));

  it.each(["Figures are shown below", "Tables of contents", "The Fig. 1 result", "Figure one", "Figure 4a contains detailed results", "Table 2 shows the sizes", "Fig. 3 is a schematic"])(
    "rejects %s",
    (text) => expect(isCaption(text)).toBe(false)
  );
});

describe("pageTokens", () => {
  it("estimates each page's tokens, leaving out page furniture", () => {
    const pages = [page(1, [`${"A".repeat(399)}.`]), page(2, [`${"B".repeat(79)}.`]), page(3, [])];
    expect(pageTokens(pages, true)).toEqual({ 1: 100, 2: 20 });
  });
});

describe("selectText", () => {
  const blocks = [
    { text: "A Study of Things", size: 18 },
    { text: "Abstract", size: 12 },
    prose("Abstract"),
    { text: "1. Introduction", size: 12 },
    prose("Body"),
    "Figure 1. The first caption, in place.",
    "x axis",
    { text: "References", size: 12 },
    ...entries("Author", 20),
    "Figure 2. A figure placed after the references.",
    { text: "Online Methods", size: 12 },
    prose("Methods"),
    { text: "References", size: 12 },
    ...entries("Second", 20),
    { text: "Appendix A", size: 12 },
    prose("Appendix"),
  ];

  it("main: removes only reference sections, captions and noise", () => {
    const { text, cuts, notes } = selectText(paper(blocks), options);
    expect(text).toContain("Body results");
    expect(text).toContain("Methods results");
    expect(text).toContain("Appendix results");
    expect(text).not.toContain("Author, A.");
    expect(text).not.toContain("Second, A.");
    expect(text).not.toContain("References");
    expect(text).not.toContain("x axis");
    expect(text).not.toContain("caption");
    expect(cuts).toMatchObject({ referencesPage: 1, captions: 2 });
    expect(cuts.referencesChars).toBeGreaterThan(1500);
    expect(notes).toEqual([]);
  });

  it("main+captions: moves captions to a final block, from anywhere", () => {
    const { text } = selectText(paper(blocks), { ...options, scope: "main+captions" });
    const block = text.split("=== Figure and table captions ===")[1];
    expect(block).toContain("Figure 1. The first caption");
    expect(block).toContain("Figure 2. A figure placed after");
    expect(text.split("Figure 1. The first").length).toBe(2);
  });

  it("de-duplicates repeated captions", () => {
    const { text } = selectText(
      paper([prose("Body"), "Figure 1. Same caption.", "Figure 1. Same  caption."]),
      { ...options, scope: "main+captions" }
    );
    expect(text.match(/Figure 1\./g)).toHaveLength(1);
  });

  it("abstract+captions: stops at the next heading", () => {
    const { text, cuts } = selectText(paper(blocks), { ...options, scope: "abstract+captions" });
    expect(text).toContain("Abstract results");
    expect(text).not.toContain("Body results");
    expect(text).toContain("Figure 2.");
    expect(cuts.abstract).toBe("heading");
  });

  it("abstract+captions: uses the first N pages with no Abstract heading", () => {
    const pages = [
      page(1, [prose("One"), "Figure 1. A caption on page one."]),
      page(2, [prose("Two")]),
      page(3, [prose("Three"), "Figure 2. A caption on page three."]),
    ];
    const { text, cuts, notes } = selectText(pages, { ...options, scope: "abstract+captions", pageCount: 2 });
    expect(text).toContain("Two results");
    expect(text).not.toContain("Three results");
    expect(text).toContain("Figure 2.");
    expect(text.match(/Figure 1\./g)).toHaveLength(1);
    expect(cuts.abstract).toBe("not-found");
    expect(notes.join()).toContain("first 2 pages");
  });

  it("pages: uses only the first N pages, unfiltered", () => {
    const pages = [page(1, [prose("One"), "tiny"]), page(2, [prose("Two")]), page(3, [prose("Three")])];
    const result = selectText(pages, { ...options, scope: "pages", pageCount: 2 });
    expect(result.text).toContain("tiny");
    expect(result.text).toContain("Two results");
    expect(result.text).not.toContain("Three results");
    expect(result.pagesUsed).toBe(2);
  });

  it("uses exactly the pages chosen in the picker, whatever the scope", () => {
    const pages = [page(1, [prose("One")]), page(2, [prose("Two")]), page(3, [prose("Three"), "tiny"])];
    const result = selectText(pages, { ...options, scope: "abstract+captions", pageList: [1, 3] });
    expect(result.text).toContain("One results");
    expect(result.text).not.toContain("Two results");
    expect(result.text).toContain("tiny");
    expect(result.scope).toBe("pages");
    expect(result.pagesUsed).toBe(2);
  });

  it("pages: reports the real count when N is past the end", () => {
    const result = selectText(paper([prose("One")]), { ...options, scope: "pages", pageCount: 9 });
    expect(result.pagesUsed).toBe(1);
  });

  it("all: keeps references and everything else", () => {
    const { text } = selectText(paper(blocks), { ...options, scope: "all" });
    expect(text).toContain("Author, A.");
    expect(text).toContain("x axis");
  });

  it.each([
    "References",
    "REFERENCES",
    "R EFERENCES",
    "7. References",
    "References:",
    "Reference",
    "Reference List",
    "References and Notes",
    "References Cited",
    "Notes and References",
    "Bibliography",
    "Literature Cited",
    "Cited Literature",
    "Works Cited",
  ])("recognizes the title %s", (title) => {
    const { text } = selectText(paper([prose("Body"), { text: title, size: 12 }, ...entries("Author", 3)]), options);
    expect(text).toContain("Body results");
    expect(text).not.toContain("Author, A.");
  });

  it("doesn't take a sentence mentioning references for the title", () => {
    const { text, cuts } = selectText(
      paper([prose("Body"), "References cited in the text below are listed.", prose("More")]),
      options
    );
    expect(text).toContain("More results");
    expect(cuts.referencesPage).toBeUndefined();
  });

  it("removes a reference section that ends the paper", () => {
    const { text } = selectText(paper([prose("Body"), { text: "References", size: 12 }, ...entries("Author", 30)]), options);
    expect(text).not.toContain("Author, A.");
    expect(text).toContain("Body results");
  });

  it.each(["Methods", "Appendix", "Appendix B", "Supplementary Information", "Acknowledgements", "Data availability"])(
    "keeps the section titled %s after the references",
    (title) => {
      const { text } = selectText(
        paper([prose("Body"), { text: "References", size: 12 }, ...entries("Author", 3), { text: title, size: 12 }, prose("After")]),
        options
      );
      expect(text).toContain("After results");
      expect(text).not.toContain("Author, A.");
    }
  );

  it("loses almost nothing to a stray References on a contents page", () => {
    const { text } = selectText(
      paper([{ text: "References", size: 12 }, { text: "1. Introduction", size: 12 }, prose("Body"), prose("More")]),
      options
    );
    expect(text).toContain("Body results");
    expect(text).toContain("More results");
  });

  it("keeps an appendix with a title of any wording after the references", () => {
    const { text } = selectText(
      paper([prose("Body"), { text: "References", size: 12 }, ...entries("Author", 3), { text: "Proofs of the Lemmas", size: 12 }, prose("Proof")]),
      options
    );
    expect(text).toContain("Proof results");
    expect(text).not.toContain("Author, A.");
  });

  it("doesn't treat a section called Literature as references", () => {
    const { text } = selectText(paper([{ text: "Literature", size: 12 }, prose("Review")]), options);
    expect(text).toContain("Review results");
  });

  it("keeps everything and says so when there's no References title", () => {
    const { text, cuts, notes } = selectText(paper([prose("Body"), ...entries("Author", 3)]), options);
    expect(text).toContain("Author, A.");
    expect(cuts.referencesPage).toBeUndefined();
    expect(notes.join()).toContain("No References section title");
  });

  it("keeps all pages when no list is found, with no page limit", () => {
    const pages = Array.from({ length: 9 }, (_, i) => page(i + 1, [prose(`Page${i}`)]));
    const { text } = selectText(pages, { ...options, pageCount: 2 });
    expect(text).toContain("Page8 results");
  });

  it("trims main text first and keeps the captions", () => {
    const caption = "Figure 1. A caption that must survive the input limit.";
    const { text, truncated, notes } = selectText(
      paper([prose("Body"), prose("Body"), prose("Body"), caption]),
      { ...options, scope: "main+captions", maxInputTokens: 400 }
    );
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(1600);
    expect(text).toContain(caption);
    expect(text).toContain("[Text truncated here");
    expect(notes.join()).toContain("Trimmed");
  });

  it("records the size before trimming", () => {
    const untrimmed = selectText(paper([prose("Body")]), options);
    const trimmed = selectText(paper([prose("Body")]), { ...options, maxInputTokens: 200 });
    expect(untrimmed.fullTokens).toBe(untrimmed.tokens);
    expect(trimmed.truncated).toBe(true);
    expect(trimmed.fullTokens).toBe(untrimmed.fullTokens);
    expect(trimmed.tokens).toBeLessThan(trimmed.fullTokens);
  });

  it("trims captions once the main text is gone", () => {
    const captions = Array.from({ length: 80 }, (_, i) => `Figure ${i + 1}. ${"long caption text ".repeat(4)}`);
    const { text, truncated } = selectText(paper([prose("Body"), ...captions]), {
      ...options,
      scope: "main+captions",
      maxInputTokens: 200,
    });
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(800);
    expect(text).toContain("Figure 1.");
  });

  it("stops on a text-less PDF", () => {
    expect(() => selectText(paper(["Scanned by CamScanner"]), options)).toThrow("No extractable text");
    expect(() => selectText([page(1, []), page(2, [])], options)).toThrow("No extractable text");
  });

  it("names the scope when only the chosen part is too short", () => {
    expect(() =>
      selectText([page(1, [prose("Body").slice(0, 300)]), page(2, [prose("Later")])], { ...options, scope: "pages", pageCount: 1 })
    ).toThrow('scope "pages"');
  });
});
