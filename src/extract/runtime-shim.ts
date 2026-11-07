// Paperlib runs extensions in a vm context built from a spread copy of the host
// globals (app/extension/manager/plugin-vm.ts). Non-enumerable Web APIs don't survive
// the spread, and pdf.js touches some of them as soon as it's imported, so they have
// to be copied in first. This module must be imported before pdf.js.
import vm from "vm";

const NEEDED = [
  "Blob",
  "BroadcastChannel",
  "DOMException",
  "Event",
  "EventTarget",
  "MessageChannel",
  "MessageEvent",
  "MessagePort",
  "ReadableStream",
  "TextDecoder",
  "TextEncoder",
  "TransformStream",
  "WritableStream",
];

const host = vm.runInThisContext("globalThis") as Record<string, unknown>;
const sandbox = globalThis as unknown as Record<string, unknown>;
for (const name of NEEDED) {
  if (sandbox[name] === undefined && host[name] !== undefined) {
    sandbox[name] = host[name];
  }
}
