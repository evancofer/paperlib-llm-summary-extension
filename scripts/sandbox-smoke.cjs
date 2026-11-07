#!/usr/bin/env node
// End-to-end check of dist/main.js with no live app or API: loads it the way Paperlib
// does, with a fake library and LLM server, and clicks through each menu item.
//
//   npm run build && npm run smoke
//
// To use the Node and V8 that Paperlib itself ships, which is what matters most:
//   ELECTRON_RUN_AS_NODE=1 /Applications/Paperlib.app/Contents/MacOS/Paperlib scripts/sandbox-smoke.cjs
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { loadExtension } = require("./sandbox.cjs");

const root = path.join(__dirname, "..");
const pdf = path.join(root, "test", "fixtures", "arxiv-2col.pdf");
const ID = "@evancofer/paperlib-llm-summary-extension";

/** A minimal PDF using a predefined Chinese CMap and no embedded font. */
function cjkPdf() {
  const line = Buffer.from("中文".repeat(15), "utf16le").swap16().toString("hex");
  const text = Array.from({ length: 30 }, () => `<${line}> Tj 0 -14 Td`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 7 0 R >>",
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>",
  ];
  const stream = `BT /F1 12 Tf 72 700 Td ${text} ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  const body = objects.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj`).join("\n");
  return `%PDF-1.4\n${body}\ntrailer << /Root 1 0 R /Size 8 >>\n%%EOF\n`;
}

async function main() {
  assert(fs.existsSync(pdf), "Run `npm run fixtures` first");

  // A stand-in for the claude binary, found through PATH.
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "plsum-bin-"));
  const fakeClaude = path.join(fakeBin, "claude");
  const fakeLog = path.join(fakeBin, "log.txt");
  fs.writeFileSync(
    fakeClaude,
    `#!/bin/sh\nprintf '%s\\n' "$*" > "${fakeLog}"\nenv | grep -c '^ANTHROPIC_API_KEY=' >> "${fakeLog}"\ncat >> "${fakeLog}"\necho '{"is_error":false,"result":"Summary from Claude Code.","stop_reason":"end_turn"}'\n`,
    { mode: 0o755 }
  );
  process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;
  process.env.ANTHROPIC_API_KEY = "sk-must-not-reach-claude-code";

  // Fake LLM server, on a real socket.
  const requests = [];
  let reply = (req) => ({ status: 200, body: { choices: [{ message: { content: `Summary ${requests.length}.` }, finish_reason: "stop" }] } });
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(data) });
      const { status, body } = reply(req);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;

  // Fake app. Everything crossing the RPC boundary goes through JSON, as it does in Paperlib.
  const rpc = (value) => JSON.parse(JSON.stringify(value));
  const papers = new Map([
    ["aaaaaaaaaaaaaaaaaaaaaaaa", { id: "aaaaaaaaaaaaaaaaaaaaaaaa", _id: "aaaaaaaaaaaaaaaaaaaaaaaa", title: "Deep Residual Learning", pubTime: "2015", publication: "arXiv", mainURL: "paper.pdf", note: "" }],
    ["bbbbbbbbbbbbbbbbbbbbbbbb", { id: "bbbbbbbbbbbbbbbbbbbbbbbb", _id: "bbbbbbbbbbbbbbbbbbbbbbbb", title: "No PDF", mainURL: "", note: "keep me" }],
  ]);
  const state = { selectedPaperEntities: [], "processingState.general": 0 };
  const logs = [];
  const listeners = new Map();
  const on = (event, cb) => {
    listeners.set(event, cb);
    return () => listeners.delete(event);
  };
  const prefs = new Map();
  const prefListeners = new Map();
  const keychain = new Map();
  let contextHandler;

  const log = (level) => (title, detail, notify) => logs.push({ level, title, detail, notify });
  const PLAPI = {
    logService: { info: log("info"), warn: log("warn"), error: log("error") },
    uiStateService: {
      getState: async (k) => rpc(k === "selectedPaperEntities" ? [...state[k]].map((id) => papers.get(id)) : state[k]),
      setState: async (patch) => Object.assign(state, patch),
    },
    paperService: {
      loadByIds: async (ids) => rpc(ids.map((id) => papers.get(id)).filter(Boolean)),
      update: async (drafts) => {
        for (const d of rpc(drafts)) papers.set(d.id, d);
        return drafts;
      },
    },
    fileService: { access: async () => `file://${pdf}` },
    commandService: {
      on,
      registerExternel: (c) => {
        logs.push({ command: c.id, event: c.event });
        return () => {};
      },
    },
  };
  const PLExtAPI = {
    extensionPreferenceService: {
      register: async (id, defaults) => {
        for (const [k, v] of Object.entries(defaults)) prefs.set(k, v.value);
      },
      unregister() {},
      get: (_id, k) => prefs.get(k),
      set: (_id, patch) => {
        for (const [k, v] of Object.entries(patch)) {
          prefs.set(k, v);
          prefListeners.get(k)?.({ key: k, value: { value: v } });
        }
      },
      onChanged: (target, cb) => {
        const [id, key] = target.split(":");
        assert.strictEqual(id, ID);
        prefListeners.set(key, cb);
        return () => prefListeners.delete(key);
      },
      getPassword: async (_id, k) => keychain.get(k) ?? null,
      setPassword: async (_id, k, v) => void keychain.set(k, v),
    },
    networkTool: {
      // Same contract as NetworkTool.post, with fetch standing in for ky.
      post: async (url, data, headers, retry, timeout, compress, parse) => {
        assert.strictEqual(typeof data, "object");
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(data),
        });
        if (!response.ok) {
          const error = new Error(`Request failed with status code ${response.status}`);
          error.name = "HTTPError";
          error.response = response;
          throw error;
        }
        return { body: parse ? await response.json() : await response.text(), status: response.status };
      },
    },
  };
  // Stands in for the picker window: reads what it's given, then answers like the page.
  const windows = [];
  let pickerAnswer = { pages: [1, 2, 3] };
  const windowOpened = async (id, options) => {
    const stub = fs.readFileSync(options.entry, "utf8");
    assert.strictEqual(options.webPreferences.nodeIntegration, false);
    assert.strictEqual(options.webPreferences.sandbox, true);
    const base = stub.match(/PICKER_BASE = "([^"]+)"/)[1];
    assert.strictEqual((await fetch(`${base.slice(0, -4)}0000/info`)).status, 404);
    assert.match((await (await fetch(`${base}/info`)).json()).title, /Deep Residual/);
    assert.strictEqual((await fetch(`${base}/pdf`)).headers.get("content-type"), "application/pdf");
    const sizes = await (await fetch(`${base}/tokens`)).json();
    assert.strictEqual(sizes.max, 30000);
    assert(sizes.pages[1] > 500, "Page sizes come from the real PDF");
    for (const asset of ["picker.js", "pdf.min.mjs", "pdf.worker.min.mjs"]) {
      assert.strictEqual((await fetch(`${base}/${asset}`)).status, 200, asset);
    }
    assert.strictEqual((await fetch(`${base}/cmaps/UniGB-UCS2-H.bcmap`)).status, 200);
    assert.strictEqual((await fetch(`${base}/..%2fmain.js`)).status, 404);
    await fetch(`${base}/${pickerAnswer ? "done" : "cancel"}`, { method: "POST", body: JSON.stringify(pickerAnswer ?? {}) });
  };
  const PLMainAPI = {
    contextMenuService: {
      registerContextMenu: (id, items) => logs.push({ menu: items }),
      unregisterContextMenu() {},
      on: (event, cb) => {
        contextHandler = cb;
        return () => {};
      },
    },
    windowProcessManagementService: {
      create: async (id, options) => windowOpened(id, options),
      destroy: (id) => windows.push(`destroyed ${id}`),
    },
  };

  const extensionModule = loadExtension(path.join(root, "dist", "main.js"), { PLAPI, PLExtAPI, PLMainAPI });
  const extension = await extensionModule.initialize();

  const settle = async () => {
    const start = logs.length;
    for (let i = 0; i < 3000; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (state["processingState.general"] === 0 && logs.length > start) return;
    }
    throw new Error("Timed out");
  };
  const click = async (itemID, ids) => {
    state.selectedPaperEntities = ids;
    contextHandler({ value: { extID: ID, itemID } });
    await settle();
    return logs.filter((l) => l.notify).pop();
  };
  const paper = () => papers.get("aaaaaaaaaaaaaaaaaaaaaaaa").note;
  const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const B = "bbbbbbbbbbbbbbbbbbbbbbbb";

  // Key handling. A new install starts on Claude Code, and this tests the HTTP path first.
  prefs.set("provider", "openai");
  PLExtAPI.extensionPreferenceService.set(ID, { baseURL, apiKey: "sk-secret" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(keychain.get("apiKey:openai"), "sk-secret");
  assert.match(prefs.get("apiKey"), /stored in keychain/);

  // Menu items and commands.
  assert.deepStrictEqual(rpc(logs.find((l) => l.menu).menu).map((m) => m.label), [
    "LLM Summary - summarize",
    "LLM Summary - summarize from selection",
  ]);
  assert.deepStrictEqual(rpc(logs.filter((l) => l.command).map((l) => l.command)), ["llmsummary", "llmsummary_selection"]);

  // Summarize: real extraction reaches the server, and one section is left.
  result = await click("summarize", [A, B]);
  assert.strictEqual(result.detail, "1 summarized, 1 skipped (no PDF)");
  assert.strictEqual(requests[0].url, "/v1/chat/completions");
  assert.strictEqual(requests[0].headers.authorization, "Bearer sk-secret");
  assert.match(requests[0].body.messages[1].content, /Paper: Deep Residual Learning \(2015, arXiv\)/);
  assert.strictEqual(papers.get(B).note, "keep me");
  await click("summarize", [A]);
  assert.strictEqual(paper().split("plsum:start").length, 2);
  assert.match(paper(), /Summary 2\./);

  // A note edited during the API call survives.
  const slowReply = reply;
  reply = () => {
    const current = papers.get(A);
    papers.set(A, { ...current, note: `${current.note}\n\nTyped during the call.` });
    return slowReply();
  };
  await click("summarize", [A]);
  reply = slowReply;
  assert.match(paper(), /Typed during the call\./);
  assert.match(paper(), /Summary 3\./);

  // A user's edit is kept, in both modes.
  papers.set(A, { ...papers.get(A), note: paper().replace("Summary 3.", "My own words.") });
  await click("summarize", [A]);
  assert.match(paper(), /My own words\./);
  assert.match(paper(), /Summary 4\./);
  prefs.set("onEdited", "skip");
  const before = requests.length;
  result = await click("summarize", [A]);
  assert.strictEqual(result.detail, "1 skipped (edited summary present)");
  assert.strictEqual(requests.length, before);
  prefs.set("onEdited", "keep-both");

  // Choosing pages sends only those pages, and replaces the unedited summary.
  const beforePick = requests.length;
  result = await click("selection", [A]);
  assert.strictEqual(result.detail, "1 summarized");
  assert.strictEqual(requests.length, beforePick + 1);
  const sent = requests[beforePick].body.messages[1].content;
  assert.match(sent, /Deeper neural networks/);
  assert.doesNotMatch(sent, /\[1\] Y\. Bengio/);
  assert.match(paper(), /scope=picked pages=3/);
  assert.deepStrictEqual(windows, ["destroyed llmsummary-picker"]);

  // CJK text needs a predefined CMap, read from dist/cmaps.
  const cjk = path.join(os.tmpdir(), `plsum-smoke-${process.pid}.pdf`);
  fs.writeFileSync(cjk, cjkPdf());
  PLAPI.fileService.access = async () => `file://${cjk}`;
  prefs.set("scope", "all");
  await click("summarize", [A]);
  prefs.set("scope", "main+captions");
  PLAPI.fileService.access = async () => `file://${pdf}`;
  fs.unlinkSync(cjk);
  assert.match(requests[requests.length - 1].body.messages[1].content, /中文/);

  // Cancelling does nothing, and a multiple selection is refused.
  pickerAnswer = null;
  const beforeCancel = requests.length;
  state.selectedPaperEntities = [A];
  contextHandler({ value: { extID: ID, itemID: "selection" } });
  while (windows.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(requests.length, beforeCancel);
  result = await click("selection", [A, B]);
  assert.match(result.detail, /one paper at a time/);

  // Claude Code needs no base URL or key, gets the text on stdin, and has no tools.
  prefs.set("provider", "claude-code");
  const beforeClaude = requests.length;
  result = await click("summarize", [A]);
  assert.strictEqual(result.detail, "1 summarized");
  assert.strictEqual(requests.length, beforeClaude);
  assert.match(paper(), /Summary from Claude Code\./);
  const claudeCall = fs.readFileSync(fakeLog, "utf8");
  assert.match(claudeCall, /^-p --output-format json --model /);
  assert.match(claudeCall, /--tools {2}--no-session-persistence/);
  assert.strictEqual(claudeCall.split("\n")[1], "0", "An API key must not reach Claude Code");
  assert.match(claudeCall, /Paper: Deep Residual Learning[\s\S]*Deeper neural networks/);
  prefs.set("provider", "openai");

  // A paper over the limit is trimmed, and the warning says so.
  prefs.set("provider", "claude-code");
  prefs.set("maxInputTokens", "2000");
  result = await click("summarize", [A]);
  assert.strictEqual(result.level, "warn");
  assert.match(result.detail, /1 trimmed to fit Max input tokens \(about [\d,]+ tokens, limit 2,000\)/);
  prefs.set("maxInputTokens", "30000");
  prefs.set("provider", "openai");
  fs.rmSync(fakeBin, { recursive: true });

  // Provider errors reach the user.
  reply = () => ({ status: 401, body: { error: { message: "Incorrect API key provided" } } });
  result = await click("summarize", [A]);
  assert.strictEqual(result.detail, "1 failed: Bad API key (HTTP 401): Incorrect API key provided");
  reply = slowReply;

  // Switching provider.
  prefs.set("model", "gpt-4o-mini");
  PLExtAPI.extensionPreferenceService.set(ID, { baseURL: "https://api.openai.com/v1", provider: "anthropic" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(prefs.get("baseURL"), "https://api.anthropic.com");
  assert.strictEqual(prefs.get("apiKey"), "");

  // Nothing selected, and over the limit.
  result = await click("summarize", []);
  assert.match(result.detail, /Select at least one paper/);
  prefs.set("batchLimit", "1");
  result = await click("summarize", [A, B]);
  assert.match(result.detail, /batch limit is 1/);

  assert.strictEqual(state["processingState.general"], 0);
  assert(!JSON.stringify(logs).includes("sk-secret"), "The key must never be logged");

  await extension.dispose();
  server.close();
  console.log(`OK on Node ${process.versions.node}${process.versions.electron ? ` / Electron ${process.versions.electron}` : ""}`);
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
