import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { parsePages, pickerStub, PickerServer, startPickerServer } from "../src/picker/server";

describe("parsePages", () => {
  it("sorts and de-duplicates valid pages", () => {
    expect(parsePages('{"pages":[3,1,3,2]}')).toEqual([1, 2, 3]);
  });

  it.each(["not json", "{}", '{"pages":"1"}', '{"pages":[0,-1,1.5,"2"]}'])("rejects %s", (body) => {
    expect(parsePages(body)).toEqual([]);
  });
});

describe("startPickerServer", () => {
  let server: PickerServer | undefined;
  const dir = mkdtempSync(path.join(os.tmpdir(), "plsum-test-"));
  writeFileSync(path.join(dir, "paper.pdf"), "%PDF-fake");
  writeFileSync(path.join(dir, "picker.js"), "// page");
  writeFileSync(path.join(dir, "secret.txt"), "private");

  const start = async (tokens: Promise<Record<number, number>> = Promise.resolve({ 1: 100 })) =>
    (server = await startPickerServer({
      pdfPath: path.join(dir, "paper.pdf"),
      title: "A <b>title</b>",
      pageTokens: tokens,
      maxTokens: 30000,
      assetDir: dir,
      cmapDir: dir,
    }));

  afterEach(() => server?.close());
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("listens on the loopback address only", async () => {
    expect((await start()).base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
  });

  it("serves the PDF, page script and title to the token holder", async () => {
    const { base } = await start();
    expect(await (await fetch(`${base}/pdf`)).text()).toBe("%PDF-fake");
    const script = await fetch(`${base}/picker.js`);
    expect(script.headers.get("content-type")).toBe("text/javascript");
    expect(await (await fetch(`${base}/info`)).json()).toEqual({ title: "A <b>title</b>" });
  });

  it("reports page sizes and the limit", async () => {
    const { base } = await start();
    expect(await (await fetch(`${base}/tokens`)).json()).toEqual({ pages: { 1: 100 }, max: 30000 });
  });

  it("still answers when the size estimate fails", async () => {
    const { base } = await start(Promise.reject(new Error("bad PDF")));
    expect(await (await fetch(`${base}/tokens`)).json()).toEqual({ pages: {}, max: 30000 });
  });

  it("refuses a wrong or missing token", async () => {
    const { base } = await start();
    const origin = base.slice(0, base.lastIndexOf("/"));
    expect((await fetch(`${origin}/pdf`)).status).toBe(404);
    expect((await fetch(`${origin}/${"0".repeat(32)}/pdf`)).status).toBe(404);
  });

  it("serves only known files", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/secret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/cmaps/..%2Fsecret.txt`)).status).toBe(404);
  });

  it("resolves to the chosen pages", async () => {
    const picker = await start();
    await fetch(`${picker.base}/done`, { method: "POST", body: '{"pages":[2,1]}' });
    expect(await picker.result).toEqual([1, 2]);
  });

  it("ignores an answer with a wrong token", async () => {
    const picker = await start();
    const origin = picker.base.slice(0, picker.base.lastIndexOf("/"));
    await fetch(`${origin}/${"0".repeat(32)}/done`, { method: "POST", body: '{"pages":[1]}' });
    await fetch(`${picker.base}/cancel`, { method: "POST" });
    expect(await picker.result).toBeNull();
  });

  it("resolves to null when cancelled or closed", async () => {
    const picker = await start();
    picker.close();
    expect(await picker.result).toBeNull();
  });
});

it("builds a stub that keeps the base URL safely quoted", () => {
  expect(pickerStub("http://127.0.0.1:1/abc")).toContain('window.PICKER_BASE = "http://127.0.0.1:1/abc"');
});
