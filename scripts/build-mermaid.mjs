// Build the mermaid engine into a single self-contained IIFE static asset.
//
// Why IIFE + a global, not an import: the DSH client module system treats
// third-party bare imports as externals (runtime "missed the module table").
// The client half therefore loads this file with a plain <script> tag and
// reads the `window.__MermaidAsset__` global it installs.
//
// Build into temp/ (gitignored cache), then sync to the shippable asset only
// when content changed. Final output: packages/dsh-mermaid/lib/assets/mermaid.js.
import { build } from "esbuild";
import { mkdir, stat, readFile, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const tmpDir = join(repoRoot, "temp", "mermaid");
const tmpFile = join(tmpDir, "mermaid.js");
const outDir = join(repoRoot, "packages", "dsh-mermaid", "lib", "assets");
const outFile = join(outDir, "mermaid.js");

await mkdir(tmpDir, { recursive: true });
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
  outfile: tmpFile,
  metafile: true,
  logLevel: "warning",
});

const outputs = Object.keys(result.metafile.outputs);
const { size } = await stat(tmpFile);
// Sync to shippable asset only when content changed (keeps deploy cp fast
// and avoids dirtying git on identical rebuilds).
let synced = false;
try {
  const [a, b] = await Promise.all([readFile(tmpFile, "utf8"), readFile(outFile, "utf8").catch(() => null)]);
  if (a !== b) {
    await writeFile(outFile, a);
    synced = true;
  }
} catch {
  await copyFile(tmpFile, outFile);
  synced = true;
}
console.log(`[build-mermaid] output files: ${outputs.length} (${outputs.join(", ") || "none"})`);
console.log(`[build-mermaid] size: ${size} bytes (${(size / 1024 / 1024).toFixed(2)} MiB)`);
console.log(`[build-mermaid] cache: temp/mermaid/mermaid.js, shipped asset ${synced ? "updated" : "unchanged"}`);
for (const warning of result.warnings || []) {
  console.warn("[build-mermaid] warning:", warning.text);
}
