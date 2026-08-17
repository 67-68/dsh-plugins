import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Static IIFE asset route. The mermaid engine is built into a single
// self-contained file (see scripts/build-mermaid.mjs) and served here so the
// client half can load it via a plain <script> tag — the client module system
// treats third-party bare imports as externals, so mermaid must never be
// imported into the client bundle.
const ASSET_ROUTE_PATH = "/plugins/dsh-mermaid/assets";
const ASSET_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;

async function serveMermaidAsset(req, res) {
  // GET / HEAD only.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(404);
    res.end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  // Prefix match, mirroring webServer's longest-prefix routing.
  if (pathname !== ASSET_ROUTE_PATH && !pathname.startsWith(`${ASSET_ROUTE_PATH}/`)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const file = pathname.slice(ASSET_ROUTE_PATH.length + 1);
  // Filename allowlist guards against traversal / unexpected extensions.
  if (!ASSET_FILE_RE.test(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const dir = fileURLToPath(new URL("./assets/", import.meta.url));
    const body = await readFile(join(dir, file));
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

export default {
  inject: [],
  apply(ctx) {
    let registered = false;
    let disposeRoute = null;
    const tryRegister = (value) => {
      if (registered) return;
      let webServer = value;
      if (webServer === undefined) {
        try {
          webServer = ctx.get("webServer");
        } catch {
          webServer = undefined;
        }
      }
      if (webServer === undefined) {
        try {
          webServer = ctx.reflect.get("webServer", false);
        } catch {
          webServer = undefined;
        }
      }
      if (webServer === undefined) return;
      disposeRoute = webServer.register({
        kind: "prefix",
        path: ASSET_ROUTE_PATH,
        handler: serveMermaidAsset,
      });
      registered = true;
    };
    // Probe now; if webServer lands later, the internal/service emission
    // re-probes. The route is optional so the plugin also loads in non-web
    // shapes (e.g. Electron over file://) where webServer is absent.
    tryRegister(void 0);
    ctx.on("internal/service", (name, value) => {
      if (name === "webServer") tryRegister(value);
    });
    ctx.effect(() => () => {
      if (disposeRoute) {
        try {
          disposeRoute();
        } catch {
          // already disposed
        }
        disposeRoute = null;
        registered = false;
      }
    }, "dsh-mermaid: asset route");
  },
};
