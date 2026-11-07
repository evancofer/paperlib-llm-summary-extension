// Runs in the picker window: draws every page as a thumbnail and reports which were chosen.
import * as pdfjs from "./pdf.min.mjs";

const THUMBNAIL_WIDTH = 190;
const base = window.PICKER_BASE;

document.head.insertAdjacentHTML(
  "beforeend",
  `<style>
  :root { color-scheme: light dark; --bg: #f5f5f5; --panel: #fff; --text: #222; --muted: #777; --line: #ddd; --accent: #2563eb; --paper: #fff; --warn: #b45309; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1e1e1e; --panel: #2a2a2a; --text: #eee; --muted: #999; --line: #444; --accent: #60a5fa; --warn: #fbbf24; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 13px -apple-system, "Segoe UI", sans-serif; }
  header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
  h1 { flex: 1; margin: 0; font-size: 13px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  #tokens { color: var(--muted); white-space: nowrap; }
  #tokens.over { color: var(--warn); font-weight: 600; }
  button { padding: 5px 12px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  button.primary { border-color: var(--accent); background: var(--accent); color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(${THUMBNAIL_WIDTH}px, 1fr)); gap: 16px; padding: 16px; }
  .page { position: relative; display: block; width: 100%; padding: 0; border: 3px solid transparent; border-radius: 6px; background: none; opacity: .4; }
  .page[aria-pressed="true"] { border-color: var(--accent); opacity: 1; }
  .sheet { display: block; width: 100%; aspect-ratio: .77; background: var(--paper); }
  canvas { display: block; width: 100%; height: auto; }
  .number { position: absolute; right: 6px; bottom: 6px; padding: 1px 6px; border-radius: 4px; background: rgba(0,0,0,.65); color: #fff; font-size: 11px; }
  .status { padding: 32px; color: var(--muted); text-align: center; }
  </style>`
);

document.body.insertAdjacentHTML(
  "beforeend",
  `<header>
    <h1 id="title">Choose pages</h1>
    <span id="tokens"></span>
    <button id="all">All</button>
    <button id="none">None</button>
    <button id="cancel">Cancel</button>
    <button id="done" class="primary" disabled>Summarize</button>
  </header>
  <div class="status" id="status">Loading…</div>
  <main id="grid"></main>`
);

const $ = (id) => document.getElementById(id);
const chosen = new Set();
let answered = false;
let lastClicked = null;
let tokens = null;

function refreshTokens() {
  if (!tokens) return;
  const total = [...chosen].reduce((sum, page) => sum + (tokens.pages[page] ?? 0), 0);
  const size = total.toLocaleString("en-US");
  const limit = tokens.max.toLocaleString("en-US");
  const over = total > tokens.max;
  $("tokens").textContent = over
    ? `About ${size} tokens: over the ${limit} limit, so the end will be trimmed`
    : `About ${size} of ${limit} tokens`;
  $("tokens").classList.toggle("over", over);
}

function refresh() {
  for (const page of document.querySelectorAll(".page")) {
    page.setAttribute("aria-pressed", String(chosen.has(Number(page.dataset.page))));
  }
  const count = chosen.size;
  $("done").disabled = count === 0;
  $("done").textContent = `Summarize ${count} ${count === 1 ? "page" : "pages"}`;
  refreshTokens();
}

function answer(route, body) {
  if (answered) return;
  answered = true;
  navigator.sendBeacon(`${base}/${route}`, body);
}

async function drawPage(doc, number, button) {
  const page = await doc.getPage(number);
  const unscaled = page.getViewport({ scale: 1 });
  const scale = (THUMBNAIL_WIDTH * window.devicePixelRatio) / unscaled.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  button.querySelector(".sheet").replaceWith(canvas);
  page.cleanup();
}

async function start() {
  const info = await (await fetch(`${base}/info`)).json();
  $("title").textContent = info.title;
  document.title = `Choose pages: ${info.title}`;

  fetch(`${base}/tokens`)
    .then((response) => response.json())
    .then((result) => {
      tokens = result;
      refreshTokens();
    })
    .catch(() => undefined); // The picker works without the estimate.

  // Workers can't load across origins, and this page's origin is a local file.
  const worker = await (await fetch(`${base}/pdf.worker.min.mjs`)).text();
  pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
    new Blob([worker], { type: "text/javascript" })
  );

  const data = await (await fetch(`${base}/pdf`)).arrayBuffer();
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    cMapUrl: `${base}/cmaps/`,
    cMapPacked: true,
  }).promise;

  // Pages are drawn as they scroll into view, as a long PDF would be slow to draw at once.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        drawPage(doc, Number(entry.target.dataset.page), entry.target).catch(() => undefined);
      }
    },
    { rootMargin: "400px" }
  );

  for (let number = 1; number <= doc.numPages; number++) {
    chosen.add(number);
    const button = document.createElement("button");
    button.className = "page";
    button.dataset.page = String(number);
    button.innerHTML = `<span class="sheet"></span><span class="number">${number}</span>`;
    button.addEventListener("click", (event) => {
      const select = !chosen.has(number);
      const from = event.shiftKey && lastClicked ? Math.min(lastClicked, number) : number;
      const to = event.shiftKey && lastClicked ? Math.max(lastClicked, number) : number;
      for (let p = from; p <= to; p++) {
        if (select) chosen.add(p);
        else chosen.delete(p);
      }
      lastClicked = number;
      refresh();
    });
    $("grid").append(button);
    observer.observe(button);
  }

  $("status").remove();
  $("all").onclick = () => {
    for (let n = 1; n <= doc.numPages; n++) chosen.add(n);
    refresh();
  };
  $("none").onclick = () => {
    chosen.clear();
    refresh();
  };
  $("done").onclick = () => {
    answer("done", JSON.stringify({ pages: [...chosen] }));
    $("done").disabled = true;
    $("done").textContent = "Summarizing…";
  };
  refresh();
}

$("cancel").onclick = () => answer("cancel", "");
window.addEventListener("pagehide", () => answer("cancel", ""));

start().catch((error) => {
  $("status").textContent = `Couldn't open this PDF: ${error.message}`;
});
