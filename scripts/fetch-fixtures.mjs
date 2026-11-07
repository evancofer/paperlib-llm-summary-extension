#!/usr/bin/env node
// Downloads the open-access test PDFs into test/fixtures/. They are not committed:
// arXiv's licence for some papers doesn't allow redistribution, and the repo stays small.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");

const FIXTURES = [
  { name: "arxiv-2col.pdf", url: "https://arxiv.org/pdf/1512.03385v1" },
  {
    name: "plos.pdf",
    url: "https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0185809&type=printable",
  },
  { name: "revtex.pdf", url: "https://arxiv.org/pdf/1602.03837v1" },
  { name: "nature.pdf", url: "https://www.nature.com/articles/s41586-021-03819-2.pdf" },
  {
    name: "biorxiv.pdf",
    url: "https://www.biorxiv.org/content/10.1101/2020.03.22.002386v3.full.pdf",
  },
];

mkdirSync(dir, { recursive: true });
let failed = 0;
for (const { name, url } of FIXTURES) {
  const target = path.join(dir, name);
  if (existsSync(target)) {
    console.log(`have ${name}`);
    continue;
  }
  try {
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok || bytes.subarray(0, 5).toString() !== "%PDF-") {
      throw new Error(`HTTP ${response.status}, not a PDF`);
    }
    writeFileSync(target, bytes);
    console.log(`got  ${name} (${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 12)})`);
  } catch (error) {
    failed++;
    console.warn(`FAILED ${name}: ${error.message}`);
  }
}
process.exitCode = failed ? 1 : 0;
