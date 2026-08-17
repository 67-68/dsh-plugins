window.__ModuleLoader__.load({
  id: "dsh-mermaid",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ── constants ─────────────────────────────────────────────────────────
    var ASSET_URL = "/plugins/dsh-mermaid/assets/mermaid.js";
    var BLOCK_SELECTOR = ".md-code-block, .code-block";
    var DONE_ATTR = "data-mermaid-rendered";
    var MAX_SOURCE_LENGTH = 8000;
    // Whitelisted diagram types (first token of the fenced source). Anything
    // else keeps its source block untouched.
    var WHITELIST = new Set([
      "flowchart",
      "graph",
      "sequenceDiagram",
      "classDiagram",
      "stateDiagram",
      "stateDiagram-v2",
      "erDiagram",
    ]);

    // ── module-level (closure) state — reset on dispose ───────────────────
    var mermaidInstance = null;
    var loadPromise = null;
    var initDone = false;
    var idCounter = 0;
    var createdContainers = [];

    var CSS = [
      ".dsh-mermaid-wrap { margin: 8px 0; }",
      ".dsh-mermaid-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }",
      ".dsh-mermaid-toolbar button { font: inherit; font-size: 12px; line-height: 18px; padding: 2px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); background: var(--dsw-alias-bg-layer-3, transparent); color: var(--dsw-alias-label-primary, inherit); cursor: pointer; }",
      ".dsh-mermaid-toolbar button:hover { border-color: var(--dsw-alias-border-l1, rgba(128,128,128,.6)); }",
      ".dsh-mermaid-svg { overflow-x: auto; }",
      ".dsh-mermaid-svg svg { max-width: 100%; height: auto; }",
      ".dsh-mermaid-error { color: var(--dsw-alias-state-error-primary, #e5484d); font-size: 12px; line-height: 18px; margin: 6px 0; }",
    ].join("\n");

    // ── asset loading (idempotent; lazy on first render) ──────────────────
    function loadMermaid() {
      if (mermaidInstance) return Promise.resolve(mermaidInstance);
      if (loadPromise) return loadPromise;
      loadPromise = new Promise((resolve, reject) => {
        if (window.__MermaidAsset__) {
          mermaidInstance = window.__MermaidAsset__;
          resolve(mermaidInstance);
          return;
        }
        const script = document.createElement("script");
        script.src = ASSET_URL;
        script.async = true;
        script.onload = () => {
          const m = window.__MermaidAsset__;
          if (!m) {
            reject(new Error("mermaid asset loaded but window.__MermaidAsset__ is missing"));
            return;
          }
          mermaidInstance = m;
          resolve(m);
        };
        script.onerror = () => {
          reject(new Error("failed to load mermaid asset: " + ASSET_URL));
        };
        document.head.appendChild(script);
      });
      return loadPromise;
    }

    function ensureInitialized(mermaid) {
      if (initDone) return;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
      });
      initDone = true;
    }

    function extractCode(el) {
      const pre = el.querySelector("pre");
      if (!pre) return "";
      return (pre.textContent || "").replace(/^\s+|\s+$/g, "");
    }

    function firstToken(code) {
      const m = /^[ \t]*([A-Za-z][A-Za-z0-9_-]*)/.exec(code);
      return m ? m[1] : "";
    }

    function uniqueId() {
      idCounter += 1;
      return "dsh-mermaid-" + idCounter + "-" + Date.now().toString(36);
    }

    function insertError(el, message) {
      const prev = el.previousElementSibling;
      if (prev && prev.getAttribute && prev.getAttribute("data-mermaid-error") === "1") return;
      const note = document.createElement("div");
      note.setAttribute("data-mermaid-error", "1");
      note.setAttribute("role", "alert");
      note.className = "dsh-mermaid-error";
      note.textContent = message;
      el.insertAdjacentElement("beforebegin", note);
    }

    function buildContainer(sourceEl, svg, code) {
      const wrap = document.createElement("div");
      wrap.className = "dsh-mermaid-wrap";
      wrap.setAttribute("data-mermaid-wrap", "1");

      const toolbar = document.createElement("div");
      toolbar.className = "dsh-mermaid-toolbar";

      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.textContent = "源码";

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.textContent = "复制源码";

      toolbar.appendChild(toggleBtn);
      toolbar.appendChild(copyBtn);

      const svgWrap = document.createElement("div");
      svgWrap.className = "dsh-mermaid-svg";
      svgWrap.innerHTML = svg;

      wrap.appendChild(toolbar);
      wrap.appendChild(svgWrap);

      let showingSvg = true;
      toggleBtn.addEventListener("click", () => {
        showingSvg = !showingSvg;
        if (showingSvg) {
          sourceEl.style.display = "none";
          svgWrap.style.display = "";
          toggleBtn.textContent = "源码";
        } else {
          sourceEl.style.display = "";
          svgWrap.style.display = "none";
          toggleBtn.textContent = "图";
        }
      });

      copyBtn.addEventListener("click", () => {
        const flash = (text) => {
          const prev = copyBtn.textContent;
          copyBtn.textContent = text;
          setTimeout(() => {
            copyBtn.textContent = prev;
          }, 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(
            () => flash("已复制"),
            () => flash("复制失败")
          );
        } else {
          flash("复制失败");
        }
      });

      return wrap;
    }

    // ── per-block processing (idempotent + streaming-aware) ───────────────
    function processElement(el) {
      // Still streaming → leave it alone; the data-streaming attribute removal
      // triggers a later scan once the message settles.
      if (el.closest("[data-streaming]") !== null) return;
      if (el.hasAttribute(DONE_ATTR)) return;

      const code = extractCode(el);
      if (code === "") return; // content not yet populated
      // Commit this block now (before the async render) so re-entrant scans
      // and repeated mutations never reprocess it.
      el.setAttribute(DONE_ATTR, "1");

      const type = firstToken(code);
      if (!WHITELIST.has(type)) return; // unsupported diagram → keep source as-is

      if (code.length > MAX_SOURCE_LENGTH) {
        insertError(el, "mermaid 源码过长（超过 " + MAX_SOURCE_LENGTH + " 字符），未渲染");
        return;
      }

      loadMermaid()
        .then((mermaid) => {
          ensureInitialized(mermaid);
          const id = uniqueId();
          return mermaid.render(id, code).then((result) => {
            const svg = result && result.svg ? result.svg : "";
            if (!svg) throw new Error("mermaid.render returned no svg");
            // mermaid 11 renders parse failures as a red "error" diagram and
            // still resolves (no reject). Intercept it before it reaches the
            // DOM so the .catch fallback keeps the source block instead.
            if (svg.includes('aria-roledescription="error"') || svg.includes("Syntax error")) {
              const preview = code.length > 80 ? code.slice(0, 80) + "…" : code;
              throw new Error("mermaid 无法解析该图：" + preview);
            }
            if (!el.isConnected) return; // block removed while rendering
            el.style.display = "none";
            const container = buildContainer(el, svg, code);
            el.insertAdjacentElement("afterend", container);
            createdContainers.push({ container, sourceEl: el });
          });
        })
        .catch((err) => {
          insertError(el, "mermaid 渲染失败：" + (err && err.message ? err.message : String(err)));
        });
    }

    // ── scan + observer (RAF-throttled) ───────────────────────────────────
    let rafScheduled = false;
    function scheduleScan() {
      if (rafScheduled) return;
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        scan();
      });
    }

    function scan() {
      const nodes = document.querySelectorAll(BLOCK_SELECTOR);
      for (let i = 0; i < nodes.length; i++) processElement(nodes[i]);
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.id = "dsh-mermaid-style";
        style.setAttribute("data-plugin", "dsh-mermaid");
        style.textContent = CSS;
        document.head.appendChild(style);

        const observer = new MutationObserver(() => {
          scheduleScan();
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-streaming"],
          characterData: true,
        });

        scheduleScan(); // initial pass for already-settled blocks

        return () => {
          observer.disconnect();
          if (style.parentNode) style.parentNode.removeChild(style);
          for (let i = 0; i < createdContainers.length; i++) {
            const entry = createdContainers[i];
            if (entry.container.parentNode) entry.container.parentNode.removeChild(entry.container);
            entry.sourceEl.style.display = "";
            entry.sourceEl.removeAttribute(DONE_ATTR);
          }
          createdContainers.length = 0;
          mermaidInstance = null;
          loadPromise = null;
          initDone = false;
        };
      }, "dsh-mermaid: observer");
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  },
});
