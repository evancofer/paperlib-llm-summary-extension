// Recreates how Paperlib loads an extension (app/extension/manager/plugin-vm.ts):
// a vm context built from a spread copy of the host globals, with a spread copy of
// `process`, and no realm-sharing. Run it with Paperlib's own Electron binary as well
// as plain Node: the Electron build shipped with Paperlib is older than current Node.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function createSandbox(injected, filePath) {
  const sandbox = { ...global, ...injected };
  if (!sandbox.Buffer) sandbox.Buffer = Buffer;
  if (!sandbox.URL) sandbox.URL = URL;
  if (!sandbox.URLSearchParams) sandbox.URLSearchParams = URLSearchParams;
  sandbox.process = { ...process, env: { ...process.env }, on() {} };
  if (!sandbox.console) sandbox.console = console;
  sandbox.global = sandbox;
  const mod = { exports: {}, id: filePath, filename: filePath, loaded: false };
  sandbox.module = mod;
  sandbox.__dirname = path.dirname(filePath);
  sandbox.__filename = filePath;
  sandbox.require = require;
  return sandbox;
}

function loadExtension(filePath, injected = {}) {
  const sandbox = createSandbox(injected, filePath);
  const context = vm.createContext(sandbox);
  const code = fs.readFileSync(filePath, "utf8");
  const wrapped = `(function(exports){
    globalThis.AbortController = globalThis['_AC'];
    globalThis.AbortSignal = globalThis['_AS'];
    ${code}
  }(module.exports));`;
  context._AC = AbortController;
  context.global._AC = AbortController;
  context._AS = AbortSignal;
  context.global._AS = AbortSignal;
  new vm.Script(wrapped, { filename: filePath }).runInContext(context, { filename: filePath });
  return sandbox.module.exports;
}

module.exports = { loadExtension };
