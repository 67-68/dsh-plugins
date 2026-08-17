// Build the mermaid engine into a single self-contained IIFE static asset.
//
// Why IIFE + a global, not an import: the DSH client module system treats
// third-party bare imports as externals (runtime "missed the module table").
// The client half therefore loads this file with a plain <script> tag and
// reads the `window.__MermaidAsset__` global it installs.
//
// Output: packages/dsh-mermaid/lib/assets/mermaid.js (no sibling chunks).
import { build } from "esbuild";
import { mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = join(repoRoot, "packages", "dsh-mermaid", "lib", "assets");
const outFile = join(outDir, "mermaid.js");

await mkdir(outDir, { recursive: true });

const result = await build({
  stdin: {
    contents:
      'import mermaid from "mermaid";\nglobalThis.__MermaidAsset__ = mermaid;\n',
    resolveDir: repoRoot,
    sourcefile: "mermaid-entry.js",
    loader: "js",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  minify: true,
  target: ["es2020"],
  outfile: outFile,
  metafile: true,
  logLevel: "warning",
});

const outputs = Object.keys(result.metafile.outputs);
const { size } = await stat(outFile);
console.log(`[build-mermaid] output files: ${outputs.length} (${outputs.join(", ") || "none"})`);
console.log(`[build-mermaid] size: ${size} bytes (${(size / 1024 / 1024).toFixed(2)} MiB)`);
for (const warning of result.warnings || []) {
  console.warn("[build-mermaid] warning:", warning.text);
}
