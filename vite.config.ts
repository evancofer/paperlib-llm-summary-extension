import commonjs from "@rollup/plugin-commonjs";
import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import modify from "rollup-plugin-modify";
import { defineConfig } from "vitest/config";

const builtins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  build: {
    // Paperlib 3.1.12 ships Electron 26, which is Node 18.
    target: "node18",
    minify: true,
    lib: {
      entry: path.resolve(__dirname, "src/main.ts"),
      fileName: () => "main.js",
      formats: ["cjs"],
    },
    rollupOptions: {
      external: builtins,
      output: { format: "cjs", inlineDynamicImports: true },
    },
    outDir: "dist",
  },
  esbuild: { keepNames: true },
  plugins: [
    commonjs(),
    {
      // Files that can't be bundled: CJK character maps, and the page picker, which
      // runs in its own window. Electron 26 needs the legacy build of pdf.js.
      name: "copy-assets",
      closeBundle() {
        const pdfjs = path.resolve(__dirname, "node_modules/pdfjs-dist");
        const picker = path.resolve(__dirname, "dist/picker");
        cpSync(path.join(pdfjs, "cmaps"), path.resolve(__dirname, "dist/cmaps"), { recursive: true });
        mkdirSync(picker, { recursive: true });
        copyFileSync(path.resolve(__dirname, "src/picker/picker.js"), path.join(picker, "picker.js"));
        for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
          copyFileSync(path.join(pdfjs, "legacy/build", file), path.join(picker, file));
        }
      },
    },
    // PLAPI, PLExtAPI and PLMainAPI are globals injected by Paperlib, so they
    // have to be removed from paperlib-api imports.
    modify({
      find: /import\s*{[^}]*}\s*from\s*"paperlib-api[^"]*"/,
      replace: (match: string) =>
        match.replace(/\b(PLAPI|PLExtAPI|PLMainAPI)\b\s*,?\s*/g, ""),
    }),
  ],
});
